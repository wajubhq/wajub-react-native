import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * `@stripe/stripe-react-native` is an optional peer. A static import of it
 * anywhere the entry point reaches makes Metro stop on "Unable to resolve
 * module" in an app that only takes Mobile Money. It may only be required
 * inside try/catch, which Metro treats as an optional dependency.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' || name === 'test' ? [] : sources(path);
    }
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('@stripe/stripe-react-native is optional', () => {
  const files = sources(join(__dirname, '..'));

  it('is never imported statically', () => {
    const offenders = files.filter((file) =>
      /(import|export)[^;]*from\s+['"]@stripe\/stripe-react-native['"]/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('is only required inside a try block', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const at = source.indexOf("require('@stripe/stripe-react-native')");
      if (at === -1) continue;
      const before = source.slice(0, at);
      expect(before.lastIndexOf('try {')).toBeGreaterThan(before.lastIndexOf('}'));
    }
  });
});
