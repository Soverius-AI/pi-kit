/** Canvas has no tab stops; use the same eight-space stops as the code's CSS. */
export function diffTextWidth(text: string, measure: (text: string) => number, space: number): number {
  let width = 0;
  const parts = text.split('\t');
  for (let i = 0; i < parts.length; i++) {
    width += measure(parts[i]);
    if (i < parts.length - 1) width = (Math.floor(width / (space * 8)) + 1) * space * 8;
  }
  return width;
}
