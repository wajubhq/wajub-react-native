/**
 * Every TypeScript sample of the README type-checks against the package as
 * it is: each ```ts / ```tsx block is compiled as its own module, in memory,
 * with `@wajub/react-native` resolved to this source.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const ROOT = join(__dirname, '..', '..');

/** What the samples take from the app around them. */
const PRELUDE = `
declare const authorizationToken: string;
declare const sessionToken: string;
declare function present(options: import('@wajub/react-native').PresentOptions): Promise<import('@wajub/react-native').PresentResult>;
declare function RootNavigator(): null;
declare function showReceipt(paymentId: string): void;
declare function showPending(): void;
declare function showError(message: string): void;
`;

function samples(): Array<{ line: number; lang: string; code: string }> {
  const found: Array<{ line: number; lang: string; code: string }> = [];
  const lines = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(tsx?)\s*$/.exec(lines[i]);
    if (!open) continue;
    const end = lines.indexOf('```', i + 1);
    found.push({ line: i + 1, lang: open[1], code: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return found;
}

it('type-checks every TypeScript sample of the README', () => {
  const blocks = samples();
  expect(blocks.length).toBeGreaterThanOrEqual(4);

  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, ROOT);
  const options: ts.CompilerOptions = {
    ...config.options,
    noEmit: true,
    declaration: false,
    // Top-level await, as in an app's module.
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    baseUrl: ROOT,
    paths: { '@wajub/react-native': ['src/index.ts'] },
  };
  const files = new Map(blocks.map((b) => [join(ROOT, `README.sample-${b.line}.${b.lang}`), `${PRELUDE}\n${b.code}\nexport {};\n`]));
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) => {
    const text = files.get(name);
    return text !== undefined ? ts.createSourceFile(name, text, version) : getSourceFile(name, version, ...rest);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => files.has(name) || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => files.get(name) ?? readFile(name);

  const program = ts.createProgram([...files.keys()], options, host);
  const problems = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && files.has(d.file.fileName))
    .map((d) => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      const sample = Number(/sample-(\d+)/.exec(d.file!.fileName)![1]);
      // README line: the block's first line, after the prelude's own lines.
      const readmeLine = sample + line - PRELUDE.split('\n').length;
      return `README.md:${readmeLine}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
  expect(problems).toEqual([]);
}, 180_000);
