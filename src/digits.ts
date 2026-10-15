/**
 * The first digit (0) of the decimal digit sets a phone keyboard may type
 * besides ASCII: Arabic-Indic (Egypt, Morocco…), Persian, N'Ko, full-width.
 */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x07c0, 0xff10];

/** Other decimal digits as ASCII ones ('٦٧' → '67'): what the payer typed is what is read. */
export function toAsciiDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9);
    out += zero === undefined ? ch : String(code - zero);
  }
  return out;
}
