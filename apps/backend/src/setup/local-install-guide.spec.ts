import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { localInstallGuide } from './local-install-guide';

describe('local installation guidance', () => {
  it('uses existing Homebrew on macOS and Linux without an automatic bootstrap', () => {
    expect(localInstallGuide('darwin', false)?.manager).toBe('brew');
    expect(localInstallGuide('linux', true, true)).toEqual({ manager: 'brew', builds: [] });
  });
  it('provides apt prerequisites and explicit CPU/CUDA/Vulkan builds on Debian/Ubuntu', () => {
    const guide = localInstallGuide('linux', true)!;
    expect(guide.manager).toBe('apt');
    expect(guide.prerequisites).toContain('sudo apt-get install');
    expect(guide.prerequisites).not.toMatch(/install.*llama/u);
    expect(guide.builds.map((entry) => entry.id)).toEqual(['cpu', 'cuda', 'vulkan']);
    expect(guide.builds[0].command).toContain('-DGGML_CUDA=OFF -DGGML_VULKAN=OFF');
    expect(guide.builds[1].command).toContain('-DGGML_CUDA=ON');
    expect(guide.builds[2].command).toContain('libvulkan-dev glslc');
    for (const build of guide.builds) {
      if (process.platform !== 'win32') execFileSync('sh', ['-n'], { input: build.command });
      expect(build.command).not.toContain('rm -');
      expect(build.command).not.toContain('sudo cmake');
      expect(build.command).toContain('https://github.com/ggml-org/llama.cpp.git');
    }
    if (process.platform !== 'win32') execFileSync('sh', ['-n'], { input: guide.swapCommand });
  });
  it('does not suggest apt on other distributions or shell installers on Windows', () => {
    const guide = localInstallGuide('linux', false)!;
    expect(guide.manager).toBe('manual');
    expect(guide.prerequisites).toBeUndefined();
    expect(guide.builds.every((entry) => !entry.command.includes('apt-get'))).toBe(true);
    expect(localInstallGuide('win32', false)).toBeUndefined();
  });
});
