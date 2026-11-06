/** Fixed lattice metadata: animation changes light and coverage, never geometry. */
export interface PixelCell {
  x: number;
  y: number;
  size: number;
  threshold: number;
  fieldX: number;
  fieldY: number;
}

export interface PixelPointer {
  x: number;
  y: number;
  strength: number;
  radius: number;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const smooth = (value: number): number => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
const dimension = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1e9, value)) : 0);

function hash(x: number, y: number): number {
  let value = Math.imul(x + 137, 374761393) ^ Math.imul(y + 719, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

/** Smooth coordinate noise, not frame-seeded randomness. */
function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const u = smooth(x - ix);
  const v = smooth(y - iy);
  const top = hash(ix, iy) * (1 - u) + hash(ix + 1, iy) * u;
  const bottom = hash(ix, iy + 1) * (1 - u) + hash(ix + 1, iy + 1) * u;
  return top * (1 - v) + bottom * v;
}

export function pixelEdgeMask(x: number, y: number, width: number, height: number): number {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return 0;
  const edge = Math.min(x / width, 1 - x / width, y / height, 1 - y / height);
  return clamp((0.26 - edge) / 0.26) ** 1.15;
}

export function createPixelCells(width: number, height: number, requestedCell = 16): PixelCell[] {
  width = dimension(width);
  height = dimension(height);
  if (!width || !height) return [];
  let size = Math.ceil(
    Math.max(4, Number.isFinite(requestedCell) ? requestedCell : 16, Math.sqrt((width * height) / 6000)),
  );
  // Account for the partial final row/column, including extremely wide viewports.
  while (Math.ceil(width / size) * Math.ceil(height / size) > 6000) {
    size = Math.max(size + 1, Math.ceil(size * 1.01));
  }
  const cells: PixelCell[] = [];
  for (let row = 0; row < Math.ceil(height / size); row++) {
    for (let col = 0; col < Math.ceil(width / size); col++) {
      const x = col * size;
      const y = row * size;
      cells.push({
        x,
        y,
        size,
        // Ordered coverage with a tiny stable coordinate-seeded variation.
        threshold: (BAYER[(row % 4) * 4 + (col % 4)] + 0.25 + hash(col, row) * 0.5) / 16,
        fieldX: (x + size / 2) / 112,
        fieldY: (y + size / 2) / 112,
      });
    }
  }
  return cells;
}

export function pixelBackingSize(width: number, height: number, dpr: number): { width: number; height: number } {
  width = dimension(width);
  height = dimension(height);
  const scale = Math.min(
    2,
    Number.isFinite(dpr) ? Math.max(1, dpr) : 1,
    Math.sqrt(2000000 / Math.max(1, width * height)),
  );
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}

export function paintPixelField(
  context: CanvasRenderingContext2D,
  cells: readonly PixelCell[],
  width: number,
  height: number,
  time: number,
  color: string,
  dim: string,
  opacity: number,
  pointer?: Readonly<PixelPointer>,
  mid: string = color,
): void {
  width = dimension(width);
  height = dimension(height);
  time = Number.isFinite(time) ? time % 100000 : 0;
  opacity = Number.isFinite(opacity) ? clamp(opacity) : 0;
  const pointerActive =
    pointer !== undefined &&
    Number.isFinite(pointer.x) &&
    Number.isFinite(pointer.y) &&
    Number.isFinite(pointer.strength) &&
    Number.isFinite(pointer.radius) &&
    pointer.strength > 0 &&
    pointer.radius > 0;
  context.clearRect(0, 0, width, height);
  if (!width || !height || !opacity) {
    context.globalAlpha = 1;
    return;
  }
  // Broad traveling light fronts have different axes/speeds from both noise fields.
  const waveX = Math.cos(time * 0.43);
  const waveY = Math.sin(time * 0.37);
  let style: string | undefined;
  for (const cell of cells) {
    const { x, y, size, fieldX, fieldY, threshold } = cell;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(size) ||
      !Number.isFinite(fieldX) ||
      !Number.isFinite(fieldY) ||
      !Number.isFinite(threshold) ||
      size <= 0
    )
      continue;
    const cx = x + size / 2;
    const cy = y + size / 2;
    const mask = Math.max(0.25, pixelEdgeMask(cx, cy, width, height));
    const broad = noise(fieldX * 0.43 + time * 0.29, fieldY * 0.43 - time * 0.21);
    const detail = noise(fieldX - time * 0.67 + 31, fieldY + time * 0.39 + 17);
    const sine = Math.sin(fieldX * 0.64 + fieldY * 0.48 - time * 1.7 + waveX + waveY);
    const wave = sine > 0 ? sine ** 6 : 0;
    let influence = 0;
    if (pointerActive && pointer) {
      const dx = cx - pointer.x;
      const dy = cy - pointer.y;
      if (Math.abs(dx) < pointer.radius && Math.abs(dy) < pointer.radius) {
        const distance = Math.hypot(dx, dy);
        if (distance < pointer.radius) influence = smooth(1 - distance / pointer.radius) * clamp(pointer.strength);
      }
    }
    const energy = clamp(broad * 0.48 + detail * 0.38 + wave * 0.28 + influence * 0.65);
    // Sparse baseline: brighter fronts add compact patches, not solid stripe walls.
    // Only a strong, nearby pointer can substantially exceed ambient coverage.
    const coverage = clamp((energy - 0.24) * 0.85 + mask * 0.08 + influence * 0.35);
    // A narrow smooth threshold shoulder avoids hard on/off flicker at low frame rates.
    const gate = smooth((coverage - threshold + 0.055) / 0.11);
    const alpha = opacity * mask * gate * (0.36 + energy * 0.64);
    if (alpha <= 0) continue;
    context.globalAlpha = alpha;
    const fill = energy > 0.73 ? color : energy > 0.48 ? mid : dim;
    if (fill !== style) context.fillStyle = style = fill;
    context.fillRect(x, y, size, size);
  }
  context.globalAlpha = 1;
}
