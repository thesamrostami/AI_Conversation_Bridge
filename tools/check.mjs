// Syntax-checks every JS file (no bundler, so this is the whole "build").
import { readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tools') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (extname(name) === '.js') files.push(p);
  }
}
walk(join(root, 'src'));
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log('ok  ', f.replace(root, ''));
  } catch (err) {
    failed += 1;
    console.error('FAIL', f.replace(root, ''), '\n', String(err.stderr));
  }
}
process.exit(failed ? 1 : 0);
