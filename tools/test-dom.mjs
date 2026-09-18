// DOM → Markdown regression test for src/content.js.
//
// Loads tools/fixtures/dom-test.html in headless Chrome, reads the extraction result the fixture
// writes into <pre id="result">, and compares it with tools/fixtures/dom-test.expected.md.
//
//   node tools/test-dom.mjs            compare with the snapshot (exit 1 on a difference)
//   node tools/test-dom.mjs --update   accept the current output as the new snapshot
//
// Needs Chrome/Chromium. Set CHROME=<path> if it is not found automatically.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'tools', 'fixtures', 'dom-test.html');
const snapshot = join(root, 'tools', 'fixtures', 'dom-test.expected.md');
const update = process.argv.includes('--update');

function findChrome() {
  const candidates = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) {
    console.error('Chrome not found — set the CHROME environment variable to the executable path.');
    process.exit(2);
  }
  return found;
}

function unescapeHtml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&');
}

const chrome = findChrome();
const dom = execFileSync(
  chrome,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--allow-file-access-from-files', '--dump-dom', pathToFileURL(fixture).href],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 },
);
const m = /<pre id="result" hidden="">([\s\S]*?)<\/pre>/.exec(dom) ?? /<pre id="result" hidden>([\s\S]*?)<\/pre>/.exec(dom);
if (!m) {
  console.error('The fixture did not produce a result (is <pre id="result"> still there? did content.js throw?).');
  process.exit(1);
}
// The fixture is loaded from file://, so a root-relative link resolves to the drive root; strip the
// drive letter so the snapshot is the same on every machine.
const actual = `${unescapeHtml(m[1])
  .replace(/\r\n/g, '\n')
  .replace(/file:\/\/\/[A-Za-z]:\//g, 'file:///')
  .trimEnd()}\n`;

if (update || !existsSync(snapshot)) {
  writeFileSync(snapshot, actual);
  console.log(`${update ? 'updated' : 'created'} ${snapshot.replace(root, '')}`);
  process.exit(0);
}

const expected = readFileSync(snapshot, 'utf8').replace(/\r\n/g, '\n');
if (actual === expected) {
  console.log('ok   DOM → Markdown output matches tools/fixtures/dom-test.expected.md');
  process.exit(0);
}

const a = actual.split('\n');
const e = expected.split('\n');
console.error('FAIL DOM → Markdown output differs from the snapshot (run with --update to accept it):');
for (let i = 0; i < Math.max(a.length, e.length); i += 1) {
  if (a[i] !== e[i]) {
    console.error(`  line ${i + 1}`);
    console.error(`  - ${e[i] ?? '<missing>'}`);
    console.error(`  + ${a[i] ?? '<missing>'}`);
  }
}
process.exit(1);
