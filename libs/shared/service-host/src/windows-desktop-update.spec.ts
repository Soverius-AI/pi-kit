import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  preflightWindowsDesktopUpdate,
  startWindowsDesktopUpdate,
  windowsDesktopUpdateScript,
  windowsUpdateLiteral,
  type WindowsDesktopUpdateOptions,
  type WindowsDesktopUpdatePlan,
  type WindowsDesktopUpdateSystem,
} from './windows-desktop-update';

const plan: WindowsDesktopUpdatePlan = {
  archive: 'C:\\staging\\pi-kit.exe',
  staging: 'C:\\staging',
  log: 'C:\\profile\\logs\\desktop-update.log',
  version: '2.0.0',
  sha512: Buffer.alloc(64, 42).toString('base64'),
};
const options: WindowsDesktopUpdateOptions = {
  root: "C:\\Users\\O'Brien\\pi-kit $test",
  executable: "C:\\Users\\O'Brien\\pi-kit $test\\pi-kit.exe",
  cliScript: "C:\\Users\\O'Brien\\pi-kit $test\\resources\\backend\\pi-kit.cjs",
  dataDir: 'C:\\profile',
  logDir: 'C:\\profile\\logs',
  serviceName: 'dev.pi-kit.custom',
  hostPid: 1234,
};
function fixture() {
  const commands: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const files = new Map<string, string>();
  const directories: string[] = [];
  const system: WindowsDesktopUpdateSystem = {
    systemRoot: 'C:\\Windows',
    run(file, args, env) {
      commands.push({ file, args, env });
      return '';
    },
    write: (file, contents) => {
      files.set(file, contents);
    },
    mkdir: (path) => {
      directories.push(path);
    },
  };
  return { system, commands, files, directories };
}

describe('Windows detached desktop updater (injected operations; no installers)', () => {
  it.skipIf(process.platform !== 'win32')(
    'parses the generated helper with the native Windows PowerShell parser without executing it',
    () => {
      const powershell = win32.join(
        process.env['SystemRoot'] ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      expect(() =>
        execFileSync(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseInput($env:PI_KIT_PARSE_SCRIPT, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }',
          ],
          {
            env: { ...process.env, PI_KIT_PARSE_SCRIPT: windowsDesktopUpdateScript('C:\\profile\\plan.json') },
            windowsHide: true,
          },
        ),
      ).not.toThrow();
    },
  );
  it('quotes PowerShell literals without evaluating user paths', () => {
    expect(windowsUpdateLiteral("C:\\O'Brien\\$x`$(bad)")).toBe("'C:\\O''Brien\\$x`$(bad)'");
    for (const path of ['bad\npath', 'bad\rpath', 'bad\0path']) expect(() => windowsUpdateLiteral(path)).toThrow();
  });

  it('writes the immutable JSON plan and launches system PowerShell through WMI, not Electron', async () => {
    const { system, commands, files } = fixture();
    await startWindowsDesktopUpdate(plan, options, system);
    expect(JSON.parse(files.get('C:\\staging\\windows-update-plan.json')!)).toEqual({ ...plan, options });
    expect(files.get('C:\\staging\\windows-update.ps1')).toBe(
      windowsDesktopUpdateScript('C:\\staging\\windows-update-plan.json'),
    );
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      expect(command.args).toContain('-NonInteractive');
    }
    const launch = commands[1];
    expect(launch.args.at(-1)).toContain('Invoke-CimMethod -ClassName Win32_Process');
    expect(launch.args.at(-1)).toContain('$r.ReturnValue -ne 0');
    expect(launch.env?.['PI_KIT_DESKTOP_UPDATE']).toContain('-File "C:\\staging\\windows-update.ps1"');
    expect(launch.env?.['PI_KIT_DESKTOP_UPDATE']).not.toContain(options.executable);
    expect(launch.args.join(' ')).not.toContain('RunAs');
  });

  it('refuses missing or malformed SHA512 before any native command or file writes', async () => {
    for (const sha512 of [undefined, '', 'bad', 'a'.repeat(128)]) {
      const { system, commands, files } = fixture();
      await expect(startWindowsDesktopUpdate({ ...plan, sha512 }, options, system)).rejects.toThrow('SHA512');
      expect(commands).toHaveLength(0);
      expect(files.size).toBe(0);
    }
  });

  it('rejects unsafe paths and unexpected versions before launching', async () => {
    const { system, commands } = fixture();
    for (const root of ['relative', 'C:\\bad"path', 'C:\\bad\npath'])
      await expect(startWindowsDesktopUpdate(plan, { ...options, root }, system)).rejects.toThrow();
    await expect(startWindowsDesktopUpdate({ ...plan, version: '2.0.0;bad' }, options, system)).rejects.toThrow(
      'version',
    );
    expect(commands).toHaveLength(0);
  });

  it('propagates synchronous scope/elevation preflight failures without scheduling anything', async () => {
    const { system, files, directories } = fixture();
    system.run = () => {
      throw new Error('Run from an already elevated terminal');
    };
    await expect(startWindowsDesktopUpdate(plan, options, system)).rejects.toThrow('elevated');
    expect(files.size).toBe(0);
    expect(directories).toEqual([]);
  });

  it('uses the same exact-root registry scope/admin preflight for CLI and detached helper', async () => {
    const { system, commands } = fixture();
    await preflightWindowsDesktopUpdate(options.root, system);
    const preflight = commands[0].args.at(-1)!;
    const script = windowsDesktopUpdateScript('C:\\plan.json');
    const shared = preflight
      .slice(preflight.indexOf('function Install-Scope'), preflight.indexOf('$null = Install-Scope'))
      .trim();
    expect(script).toContain(shared);
    expect(preflight).toContain("'CurrentUser', 'LocalMachine'");
    expect(preflight).toContain('Registry64');
    expect(preflight).toContain('Registry32');
    expect(preflight).toContain('$scopes.Count -ne 1');
    expect(preflight).toContain('IsInRole');
    expect(preflight).toContain("$scope = '/currentuser'");
    expect(preflight).toContain("$scope = '/allusers'");
    expect(preflight).toContain('[IO.FileMode]::CreateNew');
    expect(preflight).toContain('[IO.Path]::GetDirectoryName($target)');
    expect(preflight).toContain('$handle.Dispose(); [IO.File]::Delete($probe)');
    expect(preflight).toContain(windowsUpdateLiteral(options.root));
    expect(preflight).not.toContain('Start-Process');
  });

  it('refuses an elevated caller before stopping a live per-user backend rather than elevating that backend on restart', async () => {
    const { system, commands } = fixture();
    await preflightWindowsDesktopUpdate(options.root, system, true);
    expect(commands[0].args.at(-1)).toContain('Check-RestartContext $true');
    expect(commands[0].args.at(-1)).toContain('An elevated updater cannot safely restart this per-user backend');
    const script = windowsDesktopUpdateScript('C:\\plan.json');
    expect(script.indexOf('Check-RestartContext ([bool] $state.host)')).toBeLessThan(
      script.indexOf("Cli @('service', 'stop')"),
    );
  });

  it('orders checksum, identity and host checks before stop, with elevation checked again in helper', () => {
    const script = windowsDesktopUpdateScript('C:\\plan.json');
    const stop = script.indexOf("Cli @('service', 'stop')");
    const installer = script.indexOf('Start-Process -FilePath $p.archive');
    for (const check of [
      '$scope = Install-Scope',
      '$sha.ComputeHash',
      'Installer SHA512 mismatch',
      'Get-AuthenticodeSignature',
      '$state = Host-State',
    ])
      expect(script.indexOf(check)).toBeLessThan(stop);
    expect(stop).toBeLessThan(installer);
    expect(script).toContain('$state.host.pid -ne $o.hostPid');
    expect(script).toContain('$state.desktopAttached -ne $false');
    expect(script).toContain("$state.host.level -ne 'login'");
    expect(script).toContain('$state.host.install');
    expect(script).toContain('$env:PI_KIT_DATA_DIR = $o.dataDir');
    expect(script).toContain('$env:PI_KIT_LOG_DIR = $o.logDir');
    expect(script).not.toMatch(/Stop-Process|taskkill|Verb RunAs/);
  });

  it('refuses unrelated or unreadable pi-kit.exe paths in both preflight and before NSIS', async () => {
    const { system, commands } = fixture();
    await preflightWindowsDesktopUpdate(options.root, system);
    expect(commands[0].args.at(-1)).toContain('Check-OtherInstalls (Join-Path');
    expect(commands[0].args.at(-1)).toContain("'pi-kit.exe')");
    const script = windowsDesktopUpdateScript('C:\\\\plan.json');
    expect(script).toContain('Get-CimInstance -ClassName Win32_Process -Filter "Name = \'pi-kit.exe\'"');
    expect(script).toContain('if (!$process.ExecutablePath) { throw');
    expect(script).toContain('[IO.Path]::GetFullPath($process.ExecutablePath), $expected');
    const guard = 'Check-OtherInstalls $o.executable';
    expect(script.indexOf(guard)).toBeLessThan(script.indexOf("Cli @('service', 'stop')"));
    expect(script.lastIndexOf(guard)).toBeGreaterThan(script.indexOf("Cli @('service', 'stop')"));
    expect(script.lastIndexOf(guard)).toBeLessThan(script.indexOf('Start-Process -FilePath $p.archive'));
  });

  it('permits checksum-protected unsigned pairs but requires matching valid signers for signed installs', () => {
    const script = windowsDesktopUpdateScript('C:\\plan.json');
    expect(script).toContain("$current.Status -eq 'Valid'");
    expect(script).toContain("$installer.Status -ne 'Valid'");
    expect(script).toContain('$current.SignerCertificate.Subject -cne $installer.SignerCertificate.Subject');
    expect(script).toContain("$current.Status -eq 'NotSigned' -and $installer.Status -eq 'NotSigned'");
    expect(script).toContain('no code-signing identity is claimed');
  });

  it('runs NSIS silently with original root as the final unquoted /D suffix, waits, then verifies the new CLI', () => {
    const script = windowsDesktopUpdateScript('C:\\plan.json');
    expect(script).toContain("-ArgumentList ('/S ' + $scope + ' /D=' + $o.root) -PassThru -Wait");
    expect(script).toContain('$process.ExitCode -ne 0');
    expect(script).toContain('& $o.executable $o.cliScript @arguments');
    expect(script).toContain("$env:ELECTRON_RUN_AS_NODE = '1'");
    expect(script.indexOf("Cli @('--version')")).toBeGreaterThan(script.indexOf('Start-Process -FilePath'));
    expect(script).toContain("$version -cne ('pi-kit ' + $p.version)");
  });

  it('owns an exclusive per-install lock before stopping and cleans staging without removing diagnostics', () => {
    const script = windowsDesktopUpdateScript('C:\\plan.json');
    expect(script).toContain("$o.root.TrimEnd('\\\\') + '.update-lock'");
    expect(script).toContain('[IO.File]::Open($lockPath, [IO.FileMode]::CreateNew');
    expect(script.indexOf('$lock = [IO.File]::Open')).toBeLessThan(script.indexOf("Cli @('service', 'stop')"));
    expect(script).toContain('if ($lock) {');
    expect(script).toContain('$lock.Dispose()');
    expect(script).toContain('[IO.File]::Delete($lockPath)');
    expect(script).toContain('Remove-Item -LiteralPath $p.staging -Recurse -Force');
    expect(script).not.toContain('Remove-Item -LiteralPath $p.log');
  });

  it('restarts only a previously running service in finally, preserving diagnostics on installer failure', () => {
    const script = windowsDesktopUpdateScript('C:\\plan.json');
    expect(script.indexOf('$restart = $true')).toBeLessThan(script.indexOf("Cli @('service', 'stop')"));
    expect(script).toContain('} finally {\n  if ($restart)');
    expect(script).toContain("Cli @('service', 'start')");
    expect(script).toContain("Status 'failed' $_.Exception.Message");
    expect(script).toContain("($p.log + '.status.json')");
    expect(script).toContain('if ($failed) { exit 1 }');
  });
});
