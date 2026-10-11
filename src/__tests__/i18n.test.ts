import { sheetStrings } from '../i18n';

describe('payment sheet language', () => {
  it('speaks French for a French locale, with or without a region', () => {
    expect(sheetStrings('fr').payNow).toBe('Payer');
    expect(sheetStrings('fr-CM').title).toBe('Payer avec Wajub');
    expect(sheetStrings('FR_ci').fields.email).toBe('E-mail');
  });

  it('falls back to English for any other locale or none', () => {
    expect(sheetStrings('en').payNow).toBe('Pay now');
    expect(sheetStrings('pt').title).toBe('Pay with Wajub');
    expect(sheetStrings(undefined).payWith('Wave')).toBe('Pay with Wave');
  });

  it('has the same keys in both languages', () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v).map((s) => `${k}.${s}`) : [k])).sort();
    expect(keys(sheetStrings('fr'))).toEqual(keys(sheetStrings('en')));
  });
});
