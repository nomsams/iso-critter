// Bundles the ES-module src/ tree into one plain <script>. Browsers refuse to
// fetch `type="module"` scripts from a file:// page (module loading always
// goes through a CORS-mode fetch, which file:// origins fail — classic
// scripts don't have that restriction, which is the whole trick here), so
// double-clicking index.html straight off disk can't work while main.js is
// loaded as a module. This produces a single non-module bundle so the game
// runs with no server and no external build tool.
//
// Only supports the exact subset of ES module syntax this project actually
// uses — verified against the whole src/ tree before writing this, not
// assumed: single-line `import { a, b as c } from './rel.js';` and
// `export function` / `export const` declarations. No default exports, no
// `import * as`, no re-exports, no multi-line imports. If a future edit
// introduces one of those, this bundler will silently produce broken output
// (an import line only gets stripped/aliased when it matches IMPORT_RE) —
// re-run the collision/pattern checks from the sprite-forge file:// work
// before trusting it again.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ENTRY = 'src/main.js';
const OUT = 'dist/bundle.js';

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*['"](.+?)['"];?\s*$/;
const EXPORT_RE = /^export\s+(function|const)\s+/;

function resolve(fromFile, relPath) {
  return normalize(join(dirname(fromFile), relPath)).split('\\').join('/');
}

const visited = new Set();
const order = [];

function visit(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const src = readFileSync(file, 'utf8');
  for (const line of src.split('\n')) {
    const m = line.match(IMPORT_RE);
    if (m) visit(resolve(file, m[2]));
  }
  order.push(file);
}
visit(ENTRY);

const chunks = [];
for (const file of order) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const imp = line.match(IMPORT_RE);
    if (imp) {
      // Plain imported names are already in scope — their module's
      // declarations were emitted earlier in `order`. An "X as Y" alias
      // still needs a local binding at the point of use.
      for (const part of imp[1].split(',')) {
        const alias = part.trim().match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
        if (alias) out.push(`const ${alias[2]} = ${alias[1]};`);
      }
      continue;
    }
    out.push(line.replace(EXPORT_RE, '$1 '));
  }
  chunks.push(`// ---- ${file} ----\n${out.join('\n')}`);
}

mkdirSync('dist', { recursive: true });
writeFileSync(OUT, `(function () {\n"use strict";\n${chunks.join('\n\n')}\n})();\n`);
console.log(`bundled ${order.length} files -> ${OUT}`);
