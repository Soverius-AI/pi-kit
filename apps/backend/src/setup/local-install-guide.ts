import type { LocalHardware } from '@pi-kit/protocol';

/** Read-only terminal recipes: never execute sudo or a downloaded installer in the backend. */
export function localInstallGuide(
  os: string,
  apt: boolean,
  brew = false,
): NonNullable<LocalHardware['installer']['guide']> | undefined {
  if (os !== 'linux' && os !== 'darwin') return undefined;
  if (os === 'darwin' || brew) return { manager: 'brew', builds: [] };
  const root = '"$HOME/.local/share/pi-kit/llama.cpp"';
  const build = (flag: string) =>
    [
      'mkdir -p "$HOME/.local/share/pi-kit"',
      `git clone --depth 1 https://github.com/ggml-org/llama.cpp.git ${root}`,
      `cmake -S ${root} -B ${root}/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$HOME/.local" -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF ${flag}`,
      `cmake --build ${root}/build --parallel 2`,
      `cmake --install ${root}/build`,
      'export PATH="$HOME/.local/bin:$PATH"',
      'llama-server --version',
    ].join(' &&\n');
  return {
    manager: apt ? 'apt' : 'manual',
    ...(apt
      ? {
          prerequisites:
            'sudo apt-get update\nsudo apt-get install --no-install-recommends git cmake ninja-build build-essential pkg-config libssl-dev',
        }
      : {}),
    builds: [
      { id: 'cpu', command: build('-DGGML_CUDA=OFF -DGGML_VULKAN=OFF') },
      { id: 'cuda', command: build('-DGGML_CUDA=ON -DGGML_VULKAN=OFF') },
      {
        id: 'vulkan',
        command: `${apt ? 'sudo apt-get install --no-install-recommends libvulkan-dev glslc &&\n' : ''}${build('-DGGML_VULKAN=ON -DGGML_CUDA=OFF')}`,
      },
    ],
    swapCommand:
      'mkdir -p "$HOME/.local/bin" &&\ntest ! -e "$HOME/.local/bin/llama-swap" && test ! -L "$HOME/.local/bin/llama-swap" &&\ninstall -m 755 ./llama-swap "$HOME/.local/bin/llama-swap" &&\nexport PATH="$HOME/.local/bin:$PATH" &&\nllama-swap --version',
  };
}
