import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { win32 } from 'node:path';

export interface WindowsDesktopUpdatePlan {
  archive: string;
  version: string;
  staging: string;
  log: string;
  sha512?: string;
}

export interface WindowsDesktopUpdateOptions {
  root: string;
  executable: string;
  cliScript: string;
  dataDir: string;
  logDir: string;
  serviceName: string;
  hostPid?: number;
}

/** Commands are injected so tests on other platforms never invoke Windows or an installer. */
export interface WindowsDesktopUpdateSystem {
  run(file: string, args: string[], env?: NodeJS.ProcessEnv): string;
  mkdir(path: string): void;
  write(path: string, contents: string): void;
  systemRoot: string;
}
const native: WindowsDesktopUpdateSystem = {
  run: (file, args, env) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, env, timeout: 30_000 }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, contents) => writeFileSync(path, contents, { mode: 0o600 }),
  systemRoot: process.env['SystemRoot'] || 'C:\\Windows',
};

/** PowerShell single-quoted literals do not expand dollar signs, backticks or subexpressions. */
export function windowsUpdateLiteral(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('Update paths must not contain NUL or newlines.');
  return `'${value.replace(/'/g, "''")}'`;
}

// Shared by synchronous CLI preflight and the detached helper. Do not infer scope from a path or request UAC.
const scopeScript = String.raw`
function Install-Scope([string] $root) {
  $target = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $matches = @()
  foreach ($hive in @('CurrentUser', 'LocalMachine')) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive, $view)
      try {
        $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if (!$uninstall) { continue }
        try {
          foreach ($name in $uninstall.GetSubKeyNames()) {
            $key = $uninstall.OpenSubKey($name)
            try {
              $location = $key.GetValue('InstallLocation')
              if ($location -and [string]::Equals([IO.Path]::GetFullPath($location).TrimEnd('\'), $target, [StringComparison]::OrdinalIgnoreCase)) {
                $matches += $hive
              }
            } finally { if ($key) { $key.Dispose() } }
          }
        } finally { $uninstall.Dispose() }
      } finally { $base.Dispose() }
    }
  }
  $scopes = @($matches | Select-Object -Unique)
  if ($scopes.Count -ne 1) { throw 'Cannot determine a unique NSIS install scope for this exact root. Portable builds are not supported.' }
  if ($scopes[0] -eq 'LocalMachine') {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw 'This pi-kit installation is per-machine. Run pi-kit update from an already elevated terminal; remote updates never prompt for UAC.'
    }
    $scope = '/allusers'
  } else { $scope = '/currentuser' }
  # Probe actual filesystem permissions, rather than guessing from ACLs or scope.
  foreach ($directory in @($target, [IO.Path]::GetDirectoryName($target))) {
    if (![IO.Directory]::Exists($directory)) { throw ('Installation directory does not exist: ' + $directory) }
    $probe = [IO.Path]::Combine($directory, '.pi-kit-write-probe-' + [Guid]::NewGuid().ToString('N'))
    $handle = $null
    try {
      $handle = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch { throw ('Installation is not writable; run from an elevated terminal: ' + $directory + ': ' + $_.Exception.Message) }
    finally {
      if ($handle) { $handle.Dispose(); [IO.File]::Delete($probe) }
    }
  }
  return $scope
}
function Check-RestartContext([bool] $liveService) {
  if (!$liveService) { return }
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'An elevated updater cannot safely restart this per-user backend without elevating it. Nothing stopped. Update from a normal-user terminal, or stop the app/service first, update from an elevated terminal, then start it again as the normal user.'
  }
}
function Check-OtherInstalls([string] $executable) {
  # NSIS may terminate lingering pi-kit.exe processes. Never knowingly let that affect another install.
  $expected = [IO.Path]::GetFullPath($executable)
  foreach ($process in @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'pi-kit.exe'" -ErrorAction Stop)) {
    if (!$process.ExecutablePath) { throw ('Cannot verify pi-kit.exe process path for pid ' + $process.ProcessId + '; close it before updating.') }
    if (![string]::Equals([IO.Path]::GetFullPath($process.ExecutablePath), $expected, [StringComparison]::OrdinalIgnoreCase)) {
      throw ('Another pi-kit installation has a running process (pid ' + $process.ProcessId + '); close it before updating.')
    }
  }
}
`;

function powershell(ops: WindowsDesktopUpdateSystem): string {
  return win32.join(ops.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export async function preflightWindowsDesktopUpdate(
  root: string,
  system: Partial<WindowsDesktopUpdateSystem> = {},
  liveService = false,
): Promise<void> {
  const ops = { ...native, ...system };
  ops.run(powershell(ops), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ErrorActionPreference = 'Stop'; ${scopeScript}\n$null = Install-Scope ${windowsUpdateLiteral(root)}; Check-RestartContext ${liveService ? '$true' : '$false'}; Check-OtherInstalls (Join-Path ${windowsUpdateLiteral(root)} 'pi-kit.exe')`,
  ]);
}

/** Pure script generator: all release/profile values are read from JSON, never interpolated as commands. */
export function windowsDesktopUpdateScript(planFile: string): string {
  return (
    `\uFEFF$ErrorActionPreference = 'Stop'\n${scopeScript}\n$p = Get-Content -LiteralPath ${windowsUpdateLiteral(planFile)} -Raw | ConvertFrom-Json\n` +
    String.raw`
$o = $p.options
$restart = $false
$failed = $false
$lock = $null
$lockPath = $o.root.TrimEnd('\\') + '.update-lock'
function Log([string] $message) {
  Add-Content -LiteralPath $p.log -Value ('{0:o} {1}' -f [DateTime]::UtcNow, $message)
}
function Status([string] $state, [string] $message) {
  @{ state = $state; message = $message; version = $p.version; time = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath ($p.log + '.status.json') -Encoding UTF8
  Log ($state + ': ' + $message)
}
function Cli([string[]] $arguments, [int[]] $allowed = @(0), [int] $timeoutMs = 60000) {
  if ($timeoutMs -le 0) { throw 'CLI deadline expired before launch.' }
  # Arguments are internal literals; only the validated CLI script path needs quoting.
  foreach ($argument in $arguments) {
    if ($argument -notmatch '^[a-zA-Z0-9-]+$') { throw 'Unsafe internal CLI argument.' }
  }
  $stdout = $null
  $stderr = $null
  $process = $null
  try {
    $stdout = [IO.Path]::GetTempFileName()
    $stderr = [IO.Path]::GetTempFileName()
    $commandArguments = '"' + $o.cliScript + '" ' + ($arguments -join ' ')
    # Redirect to files, not pipes: a full output buffer must never deadlock the timeout wait.
    $process = Start-Process -FilePath $o.executable -ArgumentList $commandArguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $null = $process.Handle
    if (!$process.WaitForExit($timeoutMs)) {
      try { $process.Kill(); $null = $process.WaitForExit(1000) } catch { Log ('Could not terminate timed-out CLI: ' + $_.Exception.Message) }
      throw ('CLI {0} timed out after {1} ms.' -f ($arguments -join ' '), $timeoutMs)
    }
    $code = $process.ExitCode
    $output = [IO.File]::ReadAllText($stdout)
    $errorOutput = [IO.File]::ReadAllText($stderr)
    if ($allowed -notcontains $code) { throw ('CLI {0} failed ({1}): {2} {3}' -f ($arguments -join ' '), $code, $output, $errorOutput) }
    return $output
  } finally {
    if ($process) { $process.Dispose() }
    foreach ($file in @($stdout, $stderr)) {
      if ($file) {
        try { Remove-Item -LiteralPath $file -Force -ErrorAction Stop }
        catch { Log ('Could not remove CLI output file: ' + $_.Exception.Message) }
      }
    }
  }
}
function Host-State {
  $state = Cli @('service', 'status', '--json') @(0, 3) | ConvertFrom-Json
  if ($state.host) {
    if (!$o.hostPid -or $state.host.pid -ne $o.hostPid) { throw 'The expected background host changed; nothing stopped.' }
    if ($state.host.level -ne 'login' -or $state.desktopAttached -ne $false) { throw 'Close the desktop app or foreground host before updating.' }
    if (!$state.host.install -or ![string]::Equals([IO.Path]::GetFullPath($state.host.install).TrimEnd('\'), (Join-Path $o.root 'resources').TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Another pi-kit installation owns this profile; nothing stopped.'
    }
    if (!$state.installed) { throw 'The background service is not registered for restart.' }
  }
  return $state
}
function Wait-Backend([string] $expectedVersion) {
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    try {
      $remaining = [int][Math]::Max(0, [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalMilliseconds))
      $state = Cli @('service', 'status', '--json') @(0, 1, 3) $remaining | ConvertFrom-Json
    } catch { $state = $null }
    if ($state.host -and $state.host.version -ceq $expectedVersion -and $state.host.level -eq 'login' -and
        $state.host.install -and [string]::Equals([IO.Path]::GetFullPath($state.host.install).TrimEnd('\'), (Join-Path $o.root 'resources').TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      if ($state.status.state -eq 'running') { return $state }
      if ($state.status.state -eq 'failed' -or $state.status.state -eq 'stopped') {
        throw ('Service backend is ' + $state.status.state)
      }
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw ('Service backend did not become ready within 60 seconds for version ' + $expectedVersion)
}

try {
  # Let the initiating remote CLI print its acknowledgement before stopping the backend that owns its terminal.
  Start-Sleep -Milliseconds 1000
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p.log)) | Out-Null
  Status 'preflight' 'Checking installation, checksum, signatures and host before stopping anything.'
  $scope = Install-Scope $o.root
  try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
  catch { throw ('Another desktop update is in progress, or a stale update lock needs manual removal: ' + $lockPath) }
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:PI_KIT_DATA_DIR = $o.dataDir
  $env:PI_KIT_LOG_DIR = $o.logDir
  $env:PI_KIT_SERVICE_LEVEL = 'login'
  # A WMI-created process does not inherit the remote CLI environment. Explicitly pin the profile.
  $stream = [IO.File]::OpenRead($p.archive)
  $sha = [Security.Cryptography.SHA512]::Create()
  try { $hash = [Convert]::ToBase64String($sha.ComputeHash($stream)) }
  finally { $sha.Dispose(); $stream.Dispose() }
  if (!$p.sha512 -or $hash -cne $p.sha512) { throw 'Installer SHA512 mismatch; nothing stopped.' }
  $current = Get-AuthenticodeSignature -LiteralPath $o.executable
  $installer = Get-AuthenticodeSignature -LiteralPath $p.archive
  if ($current.Status -eq 'Valid') {
    if ($installer.Status -ne 'Valid' -or $current.SignerCertificate.Subject -cne $installer.SignerCertificate.Subject) {
      throw 'Installer must have a valid Authenticode signature matching the installed signer.'
    }
    Log ('Authenticode signer: ' + $current.SignerCertificate.Subject)
  } elseif ($current.Status -eq 'NotSigned' -and $installer.Status -eq 'NotSigned') {
    Log 'Unsigned installation and installer: SHA512 verified; no code-signing identity is claimed.'
  } else { throw 'Installed app or installer has an invalid or mismatched signature.' }
  Check-OtherInstalls $o.executable
  $state = Host-State
  Check-RestartContext ([bool] $state.host)
  # Repeat immediately before stop: never stop a replacement host or an attached desktop.
  $state = Host-State
  if ($state.host) {
    $restart = $true
    $restartVersion = $state.host.version
    Status 'stopping' ('Stopping expected background host ' + $o.hostPid)
    $null = Cli @('service', 'stop')
    $after = Cli @('service', 'status', '--json') @(0, 3) | ConvertFrom-Json
    if ($after.host) { throw 'A host is still running after service stop; installer not started.' }
  }
  Check-OtherInstalls $o.executable
  Status 'installing' ('Running NSIS silently in existing root: ' + $o.root + ' ' + $scope)
  # NSIS consumes the entire unquoted suffix after /D=. It MUST be last, including for roots with spaces.
  $process = Start-Process -FilePath $p.archive -ArgumentList ('/S ' + $scope + ' /D=' + $o.root) -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw ('NSIS installer exited with ' + $process.ExitCode) }
  $version = (Cli @('--version')).Trim()
  if ($version -cne $p.version -and $version -cne ('pi-kit ' + $p.version)) { throw ('Installed CLI version does not match expected release: ' + $version) }
  $restartVersion = $p.version
  Status 'installed' ('Verified installed version ' + $p.version)
} catch {
  $failed = $true
  Status 'failed' $_.Exception.Message
} finally {
  if ($restart) {
    try {
      Log 'Restarting background service using the installed CLI (also attempted after installation failure).'
      $null = Cli @('service', 'start')
      $state = Wait-Backend $restartVersion
      Log ('Service restarted, pid ' + $state.host.pid)
    } catch {
      $failed = $true
      Status 'failed' ('Service restart failed: ' + $_.Exception.Message)
    }
  }
  if ($lock) {
    $lock.Dispose()
    try { [IO.File]::Delete($lockPath) } catch { Log ('Could not remove update lock: ' + $_.Exception.Message) }
  }
  # The helper is PowerShell, not a staged Electron binary. Its script and downloaded EXE can now be removed.
  try { Remove-Item -LiteralPath $p.staging -Recurse -Force -ErrorAction Stop }
  catch { Log ('Could not clean update staging: ' + $_.Exception.Message) }
}
if ($failed) { exit 1 }
Status 'complete' 'Desktop update finished.'
exit 0
`
  );
}

/** Launch system PowerShell through WMI, outside SSH/host job objects and never from Electron. */
export async function startWindowsDesktopUpdate(
  plan: WindowsDesktopUpdatePlan,
  options: WindowsDesktopUpdateOptions,
  system: Partial<WindowsDesktopUpdateSystem> = {},
): Promise<void> {
  if (!plan.sha512 || !/^[A-Za-z0-9+/]{86}==$/.test(plan.sha512))
    throw new Error('A release SHA512 checksum (base64) is required for Windows desktop updates.');
  if (!/^\d+\.\d+\.\d+$/.test(plan.version)) throw new Error('Invalid release version.');
  for (const value of [
    plan.archive,
    plan.staging,
    plan.log,
    options.root,
    options.executable,
    options.cliScript,
    options.dataDir,
    options.logDir,
  ]) {
    windowsUpdateLiteral(value);
    if (!win32.isAbsolute(value) || value.includes('"'))
      throw new Error('Update paths must be absolute Windows paths without quotes.');
  }
  const ops = { ...native, ...system };
  await preflightWindowsDesktopUpdate(options.root, ops, options.hostPid !== undefined);
  ops.mkdir(plan.staging);
  const planFile = win32.join(plan.staging, 'windows-update-plan.json');
  const script = win32.join(plan.staging, 'windows-update.ps1');
  ops.write(planFile, JSON.stringify({ ...plan, options }));
  ops.write(script, windowsDesktopUpdateScript(planFile));
  const command = `"${powershell(ops)}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`;
  ops.run(
    powershell(ops),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference = "Stop"; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:PI_KIT_DESKTOP_UPDATE }; if ($r.ReturnValue -ne 0 -or !$r.ProcessId) { throw "Could not launch detached Windows updater: $($r.ReturnValue)" }',
    ],
    { ...process.env, PI_KIT_DESKTOP_UPDATE: command },
  );
}
