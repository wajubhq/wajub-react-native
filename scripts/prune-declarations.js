/**
 * After the declaration build: keeps only the declarations the package's
 * entry reaches, and the doc comments of its public modules only. The SDK's
 * internal modules ship as JavaScript without their declarations; an internal
 * declaration a public one refers to ships without its comments.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const LIB = path.join(__dirname, '..', 'lib');

/** The modules `src/index.ts` exports from: their doc comments are the public API's. */
const PUBLIC = new Set([
  'index',
  'types',
  'version',
  'WajubError',
  'WajubSession',
  'usePayment',
  'actionHandler',
  'client/payClient',
  'mappers/paymentMapper',
  'adapters/stripeAdapter',
  'adapters/hostedRedirect',
  'realtime/statusSubscriber',
  'components/StripeCardSection',
  'appearance/theme',
]);

const moduleOf = (file) => path.relative(LIB, file).replace(/\.d\.ts$/, '').split(path.sep).join('/');

function imports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const match of text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    for (const candidate of [`${target}.d.ts`, path.join(target, 'index.d.ts')]) {
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

const reached = new Set();
const queue = [path.join(LIB, 'index.d.ts')];
while (queue.length > 0) {
  const file = queue.pop();
  if (reached.has(file)) continue;
  reached.add(file);
  queue.push(...imports(file));
}

const all = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.d.ts')) all.push(full);
  }
})(LIB);

const printer = ts.createPrinter({ removeComments: true });
let removed = 0;
let stripped = 0;
for (const file of all) {
  if (!reached.has(file)) {
    fs.rmSync(file);
    removed += 1;
  } else if (!PUBLIC.has(moduleOf(file))) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    fs.writeFileSync(file, printer.printFile(source));
    stripped += 1;
  }
}
console.log(`declarations: ${reached.size} kept (${stripped} without comments), ${removed} internal removed`);
