import {
  createPixelCells,
  paintPixelField,
  pixelBackingSize,
  PixelCell,
  pixelEdgeMask,
  PixelPointer,
} from './pixel-field-painter';

function paint(cells: readonly PixelCell[], pointer?: Readonly<PixelPointer>, time = 0, opacity = 0.85) {
  const squares: { x: number; y: number; size: number; height: number; alpha: number; color: string }[] = [];
  const context = {
    clearRect: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
    fillRect(x: number, y: number, size: number, height: number) {
      squares.push({ x, y, size, height, alpha: this.globalAlpha, color: this.fillStyle });
    },
  };
  paintPixelField(
    context as unknown as CanvasRenderingContext2D,
    cells,
    1000,
    800,
    time,
    'primary',
    'dim',
    opacity,
    pointer,
    'mid',
  );
  expect(context.globalAlpha).toBe(1);
  return squares;
}
const key = (square: { x: number; y: number }) => `${square.x},${square.y}`;

describe('pixel-field painter', () => {
  const cells = createPixelCells(1000, 800, 16);

  it('builds a complete deterministic uniform lattice with cached sample coordinates', () => {
    expect(cells).toEqual(createPixelCells(1000, 800, 16));
    expect(cells).toHaveLength(63 * 50);
    expect(new Set(cells.map((cell) => cell.size))).toEqual(new Set([16]));
    expect(new Set(cells.map(key)).size).toBe(cells.length);
    for (const cell of cells) {
      expect(cell.x % 16).toBe(0);
      expect(cell.y % 16).toBe(0);
      expect(cell.fieldX).toBe((cell.x + 8) / 112);
      expect(cell.fieldY).toBe((cell.y + 8) / 112);
    }
  });

  it('uses all sixteen ordered thresholds in every 4x4 tile, with a repeating nearby pattern', () => {
    const block = cells.filter((cell) => cell.x < 64 && cell.y < 64);
    expect(new Set(block.map((cell) => Math.floor(cell.threshold * 16))).size).toBe(16);
    for (const cell of block) {
      const repeated = cells.find((other) => other.x === cell.x + 64 && other.y === cell.y)!;
      expect(Math.floor(repeated.threshold * 16)).toBe(Math.floor(cell.threshold * 16));
      expect(cell.threshold).toBeGreaterThan(0);
      expect(cell.threshold).toBeLessThan(1);
    }
  });

  it('changes occupancy, tone and light noticeably within half a second without moving any tile', () => {
    const baseline = paint(cells);
    const byPosition = new Map(baseline.map((square) => [key(square), square]));
    for (const time of [0.5, 1]) {
      const next = paint(cells, undefined, time);
      const nextKeys = new Set(next.map(key));
      const membershipChanges =
        baseline.filter((square) => !nextKeys.has(key(square))).length +
        next.filter((square) => !byPosition.has(key(square))).length;
      const shared = next.filter((square) => byPosition.has(key(square)));
      expect(membershipChanges).toBeGreaterThan(baseline.length * 0.08);
      expect(shared.filter((square) => square.color !== byPosition.get(key(square))!.color).length).toBeGreaterThan(
        shared.length * 0.1,
      );
      expect(
        shared.filter((square) => Math.abs(square.alpha - byPosition.get(key(square))!.alpha) > 0.03).length,
      ).toBeGreaterThan(shared.length * 0.15);
      for (const square of next) {
        expect(square.size).toBe(16);
        expect(square.height).toBe(16);
        expect(square.x % 16).toBe(0);
        expect(square.y % 16).toBe(0);
      }
      expect(next).toEqual(paint(cells, undefined, time));
    }
  });

  it('evolves spatially correlated patches rather than independent per-frame random pixels', () => {
    // Equal thresholds reveal the underlying field without the deliberate Bayer contrast.
    const probes = cells.filter((cell) => cell.y === 0).map((cell) => ({ ...cell, threshold: 0 }));
    const frame = paint(probes, undefined, 0.7);
    const adjacent = frame.slice(1).map((square, i) => Math.abs(square.alpha - frame[i].alpha));
    const distant = frame.slice(12).map((square, i) => Math.abs(square.alpha - frame[i].alpha));
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(adjacent)).toBeLessThan(mean(distant) * 0.5);
    const nearbyTime = paint(probes, undefined, 0.701);
    expect(mean(frame.map((square, i) => Math.abs(square.alpha - nearbyTime[i].alpha)))).toBeLessThan(0.002);
  });

  it('keeps ambient edge-strip occupancy sparse to medium throughout the moving waves', () => {
    const inEdgeStrip = (square: { x: number; y: number; size: number }) => {
      const x = square.x + square.size / 2;
      const y = square.y + square.size / 2;
      return x < 120 || x > 880 || y < 96 || y > 704;
    };
    const available = cells.filter(inEdgeStrip).length;
    for (const time of [0, 0.5, 1, 1.5, 2, 3, 5, 8, 12, 20, 40]) {
      const occupancy = paint(cells, undefined, time).filter(inEdgeStrip).length / available;
      expect(occupancy).toBeGreaterThanOrEqual(0.2);
      expect(occupancy).toBeLessThanOrEqual(0.45);
    }
  });

  it('uses the supplied dim, mid and primary palette', () => {
    expect(new Set(paint(cells).map((square) => square.color))).toEqual(new Set(['dim', 'mid', 'primary']));
    const context = { clearRect: vi.fn(), fillRect: vi.fn(), globalAlpha: 1, fillStyle: '' };
    paintPixelField(context as unknown as CanvasRenderingContext2D, cells, 1000, 800, 0, 'primary', 'dim', 0.85);
    expect(['primary', 'dim']).toContain(context.fillStyle);
  });

  it('lights nearby tiles and raises local density without displacing them or changing distant tiles', () => {
    const baseline = paint(cells);
    const pointer = { x: 80, y: 80, strength: 1, radius: 150 };
    const lit = paint(cells, pointer);
    const local = (square: { x: number; y: number }) => Math.hypot(square.x + 8 - 80, square.y + 8 - 80) < 150;
    expect(lit.filter(local).length).toBeGreaterThan(baseline.filter(local).length);
    expect(lit.filter((square) => !local(square))).toEqual(baseline.filter((square) => !local(square)));
    const byPosition = new Map(lit.map((square) => [key(square), square]));
    for (const square of baseline.filter(local)) {
      expect(byPosition.get(key(square))!.alpha).toBeGreaterThanOrEqual(square.alpha);
    }
    expect(lit.every((square) => square.x % 16 === 0 && square.y % 16 === 0 && square.size === 16)).toBe(true);
  });

  it('preserves exact baseline for absent, zero, distant and invalid pointers', () => {
    const baseline = paint(cells, undefined, 0.6);
    const pointer = { x: 80, y: 80, strength: 1, radius: 150 };
    for (const override of [
      { strength: 0 },
      { strength: -1 },
      { strength: NaN },
      { x: NaN },
      { y: Infinity },
      { radius: 0 },
      { radius: -1 },
      { radius: Infinity },
      { x: -10000, y: -10000 },
    ]) {
      expect(paint(cells, { ...pointer, ...override }, 0.6)).toEqual(baseline);
    }
  });

  it('lets a faint field cross the centre while the edges stay strongest, at all times and pointers', () => {
    expect(pixelEdgeMask(500, 400, 1000, 800)).toBe(0);
    expect(pixelEdgeMask(10, 400, 1000, 800)).toBeGreaterThan(0.9);
    const central = (square: { x: number; y: number; size: number }) =>
      square.x + square.size > 260 && square.x < 740 && square.y + square.size > 208 && square.y < 592;
    const centralKeys = new Set<string>();
    let edgePeak = 0;
    for (const time of [0, 0.5, 1, 3, 10, 50]) {
      const ambient = paint(cells, undefined, time);
      ambient.filter(central).forEach((square) => centralKeys.add(key(square)));
      edgePeak = Math.max(edgePeak, ...ambient.filter((square) => !central(square)).map((square) => square.alpha));
      for (const [x, y] of [
        [250, 400],
        [750, 400],
        [500, 200],
        [500, 600],
        [500, 400],
      ]) {
        for (const square of paint(cells, { x, y, strength: 10, radius: 500 }, time)) {
          expect([square.x, square.y, square.size, square.alpha].every(Number.isFinite)).toBe(true);
          expect(square.alpha).toBeGreaterThan(0);
          expect(square.alpha).toBeLessThanOrEqual(0.85);
          if (central(square)) expect(square.alpha).toBeLessThanOrEqual(0.85 * 0.25);
        }
      }
    }
    expect(centralKeys.size).toBeGreaterThan(cells.filter(central).length * 0.2);
    expect(edgePeak).toBeGreaterThan(0.85 * 0.25 * 2);
  });

  it('sanitizes bad inputs and bounds alpha even with excessive opacity', () => {
    expect(createPixelCells(NaN, 800, 16)).toEqual([]);
    expect(createPixelCells(1000, -1, 16)).toEqual([]);
    expect(createPixelCells(1000, 800, NaN)).toEqual(cells);
    expect(paint(cells, undefined, NaN)).toEqual(paint(cells));
    expect(paint(cells, undefined, Infinity)).toEqual(paint(cells));
    expect(paint(cells, undefined, 0, NaN)).toEqual([]);
    expect(paint(cells, undefined, 0, -1)).toEqual([]);
    expect(paint(cells, undefined, 0, 10).every((square) => square.alpha <= 1)).toBe(true);
    expect(paint([{ ...cells[0], x: NaN }])).toEqual([]);
    expect(pixelEdgeMask(NaN, 0, 1000, 800)).toBe(0);
  });

  it('caps complete grids at 6000 cells and backing stores at DPR2 / two megapixels', () => {
    expect(pixelBackingSize(100, 100, 4)).toEqual({ width: 200, height: 200 });
    for (const [width, height] of [
      [12000, 8000],
      [1000000, 1],
      [1e9, 1e9],
    ]) {
      const large = pixelBackingSize(width, height, 3);
      expect(large.width * large.height).toBeLessThanOrEqual(2000000);
      const grid = createPixelCells(width, height, 1);
      expect(grid.length).toBeLessThanOrEqual(6000);
      expect(new Set(grid.map((cell) => cell.size)).size).toBe(1);
      const size = grid[0].size;
      expect(grid).toHaveLength(Math.ceil(width / size) * Math.ceil(height / size));
    }
    expect(pixelBackingSize(0, 0, 2)).toEqual({ width: 0, height: 0 });
    expect(pixelBackingSize(NaN, Infinity, NaN)).toEqual({ width: 0, height: 0 });
  });
});
