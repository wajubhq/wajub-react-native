/** Colour values of the appearance API (spec appearance.md §1.2). */

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0').toUpperCase();

/**
 * `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` or `rgba(r, g, b, a)`, any
 * case, as `#RRGGBB` (or `#RRGGBBAA`). Anything else — named colours,
 * `oklch()` — is undefined: ignored, never an error.
 */
export function parseColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return `#${m[1].split('').map((c) => c + c).join('')}`.toUpperCase();
  m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (m) return `#${m[1]}`.toUpperCase();
  m = /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)\s*,\s*(\d{1,3}(?:\.\d+)?)\s*,\s*(\d{1,3}(?:\.\d+)?)\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i.exec(v);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if ([r, g, b].some((c) => c > 255)) return undefined;
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    if (alpha < 0 || alpha > 1) return undefined;
    return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha < 1 ? hex2(alpha * 255) : ''}`;
  }
  return undefined;
}

function channels(color: string): [number, number, number] {
  const h = color.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance. */
export function luminance(color: string): number {
  const [r, g, b] = channels(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` blended towards `b` by `amount` (0 → a, 1 → b). */
export function mix(a: string, b: string, amount: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return `#${ca.map((c, i) => hex2(c + (cb[i] - c) * amount)).join('')}`;
}

/** `#FFFFFF` or `#0A0A0A`, whichever reads better on `background`. */
export function readableOn(background: string): string {
  return contrast('#FFFFFF', background) >= contrast('#0A0A0A', background) ? '#FFFFFF' : '#0A0A0A';
}
