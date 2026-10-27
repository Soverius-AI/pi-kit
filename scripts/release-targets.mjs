/** Release files and electron-builder output folders, shared by the release CLI and its checks. */
export function releaseTargets(version) {
  return {
    mac: { group: 'mac', arch: 'arm64', triple: 'darwin-arm64', artifacts: [`pi-kit-${version}-mac-arm64.dmg`, `pi-kit-${version}-mac-arm64.zip`], updateInfo: 'latest-mac.yml', unpacked: 'mac-arm64' },
    'win-x64': { group: 'win', arch: 'x64', triple: 'win32-x64', artifacts: [`pi-kit-${version}-win-x64.exe`, `pi-kit-${version}-win-x64-portable.exe`], updateInfo: 'latest.yml', unpacked: 'win-unpacked' },
    'win-arm64': { group: 'win', arch: 'arm64', triple: 'win32-arm64', artifacts: [`pi-kit-${version}-win-arm64.exe`, `pi-kit-${version}-win-arm64-portable.exe`], updateInfo: 'latest.yml', unpacked: 'win-arm64-unpacked' },
    'linux-x64': { group: 'linux', arch: 'x64', triple: 'linux-x64', artifacts: [`pi-kit-${version}-linux-x86_64.AppImage`], updateInfo: 'latest-linux.yml', unpacked: 'linux-unpacked' },
    'linux-arm64': { group: 'linux', arch: 'arm64', triple: 'linux-arm64', artifacts: [`pi-kit-${version}-linux-arm64.AppImage`], updateInfo: 'latest-linux-arm64.yml', unpacked: 'linux-arm64-unpacked' },
  };
}

export function selectTargets(only, platform = process.platform, arch = process.arch) {
  const requested = only?.length ? only.flatMap((name) => name.split(',')) : platform === 'linux' ? [`linux-${arch}`] : ['mac', 'win'];
  return [...new Set(requested.flatMap((name) => {
    name = name.trim();
    if (name === 'win') return ['win-x64', 'win-arm64'];
    if (name === 'linux') return [`linux-${arch}`];
    return [name];
  }))];
}

/** node-pty has no Linux prebuilds: each Linux target needs a matching host's source build. */
export function assertLinuxHost(triples, platform = process.platform, arch = process.arch) {
  for (const triple of triples) {
    if (triple.startsWith('linux-') && triple !== `${platform}-${arch}`) {
      throw new Error(`${triple} requires a matching Linux host to compile node-pty. Use the release workflow's native Linux runners, run pnpm run release --only ${triple} on that architecture, or build it in a Linux container with pnpm run package:linux:docker -- --arch ${triple.slice('linux-'.length)}.`);
    }
  }
}
