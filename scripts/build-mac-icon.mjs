// Regenerate the committed macOS app icon from icon.png on a Mac:
//   pnpm run build:mac-icon
// Use Apple's encoder: electron-builder's PNG-to-ICNS conversion produces a
// corrupted 32x32 representation in Finder. Commit icon.icns so packaging on
// other hosts does not need Apple's tools.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error('Generating icon.icns requires macOS (sips and iconutil). Use the committed icon.icns when packaging elsewhere.');
}

const resources = fileURLToPath(new URL('../apps/desktop/build/', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'pi-kit-icon-'));
try {
  const iconset = join(temp, 'icon.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      execFileSync('sips', ['-z', pixels, pixels, join(resources, 'icon.png'), '--out', join(iconset, name)], { stdio: 'pipe' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'icon.icns')], { stdio: 'inherit' });
  console.log('Wrote apps/desktop/build/icon.icns');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
