import { describe, expect, it } from 'vitest';
import { configFlags, launchdConfig, systemdConfig, processEndpoint } from './local-llama-swap-discovery';

describe('llama-swap service config discovery', () => {
  it('uses the actual process listener, including wildcard, TLS and custom ports', () => {
    expect(processEndpoint('llama-swap -config /config.yaml')).toBe('http://127.0.0.1:8080');
    expect(processEndpoint('llama-swap -listen=0.0.0.0:9090')).toBe('http://127.0.0.1:9090');
    expect(processEndpoint('llama-swap --listen "[::]:9091"')).toBe('http://[::1]:9091');
    expect(processEndpoint('llama-swap -tls-cert-file /cert.pem')).toBe('https://127.0.0.1:8443');
    expect(processEndpoint('llama-swap -listen http://example.com:8080/path')).toBeUndefined();
  });
  it('reads flag variants and quoted or ps-unquoted paths without executing their contents', () => {
    for (const flags of ['--config "/models/my setup/config.yaml" --listen :8080', '-config=/models/my setup/config.yaml -watch-config', "--config '/models/my setup/config.yaml'"]) {
      expect(configFlags(`llama-swap ${flags}`)).toEqual([{ path: '/models/my setup/config.yaml', directory: false }]);
    }
    expect(configFlags('llama-swap --config settings/config.yml', '/srv/llama')).toEqual([{ path: '/srv/llama/settings/config.yml', directory: false }]);
    expect(configFlags('llama-swap --config-dir /srv/configs --watch-config')).toEqual([{ path: '/srv/configs', directory: true }]);
    expect(configFlags('llama-swap --config relative.yaml')).toEqual([]);
    expect(configFlags('llama-swap --config "/tmp/$(never-run).yaml"')).toEqual([{ path: '/tmp/$(never-run).yaml', directory: false }]);
  });
  it('finds stopped launchd configs from the executable and working directory', () => {
    expect(launchdConfig({ ProgramArguments: ['/opt/homebrew/bin/llama-swap', '--config', 'config with spaces.yaml', '--watch-config'], WorkingDirectory: '/srv/models' })).toEqual([{ path: '/srv/models/config with spaces.yaml', directory: false }]);
    expect(launchdConfig({ ProgramArguments: ['/tools/unrelated', '--config', '/not-llama.yaml'] })).toEqual([]);
  });
  it('reads systemd ExecStart and continuation lines as data', () => {
    expect(systemdConfig('[Service]\nWorkingDirectory=/srv/models\nExecStart=/tools/llama-swap \\\n  -config config.yaml -watch-config\n')).toEqual([{ path: '/srv/models/config.yaml', directory: false }]);
    expect(systemdConfig('ExecStart=/tools/other --config /unrelated.yaml')).toEqual([]);
  });
});
