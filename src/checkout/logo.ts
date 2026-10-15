/** An SVG, by its URL: React Native's `Image` cannot draw one. */
function isSvg(url: string): boolean {
  return /\.svgz?(?:[?#]|$)/i.test(url) || /^data:image\/svg/i.test(url);
}

/**
 * The image the sheet can draw for a channel or an operator: its PNG when
 * the API gives one, else its logo unless that is an SVG; `null` otherwise
 * (the brand badge is drawn instead).
 */
export function drawableLogo(logo: string | null | undefined, logoPng?: string | null): string | null {
  if (logoPng) return logoPng;
  if (logo && !isSvg(logo)) return logo;
  return null;
}
