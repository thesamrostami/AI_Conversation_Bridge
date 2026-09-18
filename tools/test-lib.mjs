// Lightweight functional tests for the pure library modules (run: node tools/test-lib.mjs).
import assert from 'node:assert/strict';

// ---- chrome.storage mock ----
const mem = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) return Object.fromEntries(mem);
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((k) => mem.has(k)).map((k) => [k, mem.get(k)]));
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) mem.set(k, JSON.parse(JSON.stringify(v)));
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) mem.delete(k);
      },
      async getBytesInUse() {
        return JSON.stringify(Object.fromEntries(mem)).length;
      },
    },
  },
};

const { renderMarkdown, markdownToPlain } = await import('../src/lib/markdown.js');
const { toMarkdown, toHtml, toPlain, filenameFor, frontmatterFor } = await import('../src/lib/exporters.js');
const { createZip } = await import('../src/lib/zip.js');
const { detectImport } = await import('../src/lib/importers.js');
const { relatedConversations, autoTagsFor, buildContextPacket, tokenize } = await import('../src/lib/similarity.js');
const store = await import('../src/lib/storage.js');
const { slugify, safeFilename } = await import('../src/lib/util.js');
const { idForUrl } = store;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok  ', name);
  } catch (err) {
    console.error('FAIL', name, '\n   ', err.message);
    process.exitCode = 1;
  }
}
async function atest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok  ', name);
  } catch (err) {
    console.error('FAIL', name, '\n   ', err.message);
    process.exitCode = 1;
  }
}

// ---- markdown ----
test('markdown: headings, inline, code', () => {
  const html = renderMarkdown('# Title\n\nSome **bold** and *em* and `code` and [link](https://x.y/z).\n\n```js\nconst a = 1;\n```');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/x.y\/z"/);
  assert.match(html, /<pre data-lang="js"><code class="language-js">const a = 1;<\/code><\/pre>/);
});
test('markdown: escapes html and blocks javascript links', () => {
  const html = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1))');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /javascript:/);
});
test('markdown: nested lists and tasks', () => {
  const html = renderMarkdown('- a\n  - b\n  - c\n- d\n- [x] done\n\n1. one\n2. two');
  assert.match(html, /<ul><li>a<ul><li>b<\/li><li>c<\/li><\/ul><\/li><li>d<\/li><li class="task done">done<\/li><\/ul>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
});
test('markdown: table + blockquote + hr', () => {
  const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n---');
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
});
test('markdown: inline code protects markers', () => {
  const html = renderMarkdown('use `**not bold**` here');
  assert.match(html, /<code>\*\*not bold\*\*<\/code>/);
});
test('markdownToPlain strips syntax', () => {
  assert.equal(markdownToPlain('# H\n\n**b** `c` [l](u)'), 'H\n\nb c l (u)');
});

// ---- exporters ----
const conv = {
  id: 'conv_1',
  title: 'Test: chat / one',
  platform: 'chatgpt',
  url: 'https://chatgpt.com/c/abc',
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z',
  tags: ['research', 'x'],
  notes: 'note',
  messages: [
    { id: 'm1', role: 'user', content: 'Hello **there**' },
    { id: 'm2', role: 'assistant', content: '```py\nprint(1)\n```' },
  ],
};
test('toMarkdown basic + frontmatter', () => {
  const md = toMarkdown(conv, { frontmatter: true });
  assert.match(md, /^---\ntitle: "Test: chat \/ one"/);
  assert.match(md, /tags:\n  - "research"\n  - "x"/);
  assert.match(md, /## User\n\nHello \*\*there\*\*/);
  assert.match(md, /## Assistant\n\n```py\nprint\(1\)\n```/);
  const plainMd = toMarkdown(conv, { selectedIds: new Set(['m2']) });
  assert.doesNotMatch(plainMd, /Hello/);
  assert.match(plainMd, /- Messages: 1/);
});
test('toHtml renders messages and escapes title', () => {
  const html = toHtml({ ...conv, title: '<b>x</b>' });
  assert.match(html, /<title>&lt;b&gt;x&lt;\/b&gt;<\/title>/);
  assert.match(html, /class="msg user"/);
  assert.match(html, /<pre data-lang="py">/);
});
test('toPlain', () => {
  const txt = toPlain(conv);
  assert.match(txt, /USER\nHello there/);
});
test('filenameFor + safeFilename + slugify', () => {
  assert.equal(filenameFor(conv, '{date} {title}', 'md'), '2026-09-10 Test chat one.md');
  assert.equal(safeFilename('a<b>:c|d?*e'), 'a b c d e');
  assert.equal(slugify('Hello, World!'), 'hello-world');
});
test('idForUrl stable and rejects landing pages', () => {
  assert.equal(idForUrl('https://chatgpt.com/c/abc'), idForUrl('https://chatgpt.com/c/abc/'));
  assert.equal(idForUrl('https://claude.ai/new'), null);
  assert.equal(idForUrl('https://chatgpt.com/'), null);
});

// ---- zip ----
test('zip structure', () => {
  const zip = createZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.md', data: '# hi' }]);
  const sig = (o) => zip[o] | (zip[o + 1] << 8) | (zip[o + 2] << 16) | (zip[o + 3] << 24);
  assert.equal(sig(0) >>> 0, 0x04034b50);
  assert.equal(sig(zip.length - 22) >>> 0, 0x06054b50);
  const count = zip[zip.length - 22 + 10] | (zip[zip.length - 22 + 11] << 8);
  assert.equal(count, 2);
});

// ---- importers ----
test('detectImport chatgpt', () => {
  const data = [
    {
      title: 'GPT chat',
      create_time: 1700000000,
      conversation_id: 'x1',
      current_node: 'n3',
      mapping: {
        n1: { id: 'n1', parent: null, children: ['n2'], message: { id: 'n1', author: { role: 'system' }, content: { content_type: 'text', parts: [''] } } },
        n2: { id: 'n2', parent: 'n1', children: ['n3'], message: { id: 'n2', author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] }, create_time: 1700000001 } },
        n3: { id: 'n3', parent: 'n2', children: [], message: { id: 'n3', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['hello'] }, create_time: 1700000002 } },
      },
    },
  ];
  const r = detectImport(data);
  assert.equal(r.kind, 'chatgpt');
  assert.equal(r.conversations[0].messages.length, 2);
  assert.equal(r.conversations[0].url, 'https://chatgpt.com/c/x1');
});
test('detectImport claude', () => {
  const r = detectImport([{ uuid: 'u1', name: 'C', created_at: '2026-01-01T00:00:00Z', chat_messages: [{ uuid: 'a', sender: 'human', text: 'q' }, { uuid: 'b', sender: 'assistant', content: [{ type: 'text', text: 'a' }] }] }]);
  assert.equal(r.kind, 'claude');
  assert.equal(r.conversations[0].messages[1].content, 'a');
});
test('detectImport bridge backup', () => {
  const r = detectImport({ conversations: [conv] });
  assert.equal(r.kind, 'bridge');
});

// ---- similarity ----
test('autoTags + related', () => {
  const a = { id: 'a', title: 'React hooks tutorial', tags: [], messages: [{ role: 'user', content: 'How do react hooks work with useEffect and useState?' }] };
  const b = { id: 'b', title: 'useEffect cleanup in React', tags: [], messages: [{ role: 'user', content: 'react useEffect cleanup function useState' }] };
  const c = { id: 'c', title: 'Sourdough starter', tags: [], messages: [{ role: 'user', content: 'flour water salt levain' }] };
  const tags = autoTagsFor(a);
  assert.ok(tags.includes('react'));
  const rel = relatedConversations(a, [b, c]);
  assert.equal(rel.length, 1);
  assert.equal(rel[0].conversation.id, 'b');
  const packet = buildContextPacket({ title: 'W', goal: 'G' }, [a, b], 'working', { instruction: 'Go' });
  assert.match(packet, /# W\n\nGoal: G/);
  assert.match(packet, /## React hooks tutorial/);
  assert.match(packet, /Go\n$/);
});

// ---- storage ----
await atest('storage: save/upsert/update/delete/restore', async () => {
  const meta = await store.saveConversation({ ...conv, id: undefined });
  assert.equal(meta.id, idForUrl(conv.url));
  assert.equal(meta.messageCount, 2);
  await store.updateConversation(meta.id, { tags: ['keep'], favorite: true });
  // a fresh page capture carries no user metadata — existing tags/flags must survive
  const again = await store.saveConversation({ ...conv, id: undefined, tags: [], notes: '', favorite: false, messages: [...conv.messages, { role: 'user', content: 'more' }] });
  assert.equal(again.id, meta.id);
  assert.deepEqual(again.tags, ['keep'], 'user tags preserved on re-save');
  assert.equal(again.favorite, true);
  assert.equal(again.messageCount, 3);
  assert.equal((await store.listConversations()).length, 1);
  const full = await store.getConversation(meta.id);
  assert.equal(full.messages.length, 3);
  await store.deleteConversation(meta.id);
  assert.equal((await store.listConversations()).length, 0);
  assert.equal((await store.listTrash()).length, 1);
  await store.restoreFromTrash(meta.id);
  assert.equal((await store.listConversations()).length, 1);
  assert.equal((await store.listTrash()).length, 0);
});
await atest('storage: migration from 0.3.0 keys', async () => {
  mem.clear();
  mem.set('conversationBridge.conversations', [{ ...conv, id: 'old', url: 'https://claude.ai/chat/xyz', tags: ['legacy'] }]);
  mem.set('conversationBridge.templates', [{ id: 'template_critique', title: 'x', body: 'y' }, { id: 'custom1', title: 'Mine', body: 'b' }]);
  mem.set('conversationBridge.workspaces', [{ id: 'ws1', title: 'W', goal: '' }]);
  const r = await store.migrate();
  assert.equal(r.migrated, 1);
  const list = await store.listConversations();
  assert.equal(list[0].tags[0], 'legacy');
  assert.equal(list[0].id, idForUrl('https://claude.ai/chat/xyz'));
  const tpl = await store.listTemplates();
  assert.ok(tpl.some((t) => t.id === 'custom1'));
  assert.equal((await store.listWorkspaces()).length, 1);
  const r2 = await store.migrate();
  assert.equal(r2.migrated, 0, 'migration runs once');
});
await atest('storage: backup + import round trip', async () => {
  const backup = await store.exportBackup();
  await store.clearAllData();
  assert.equal((await store.listConversations()).length, 0);
  const n = await store.importBackup(backup);
  assert.equal(n, 1);
  assert.equal((await store.listConversations()).length, 1);
});

// ---- regressions ----
test('safeFilename strips backslashes and trailing dots', () => {
  assert.equal(safeFilename('Fix C:\\Users\\me\\app.js error...'), 'Fix C Users me app.js error');
  assert.equal(filenameFor({ title: 'a\\b', createdAt: '2026-01-02T00:00:00Z' }, '{date} {title}', 'md'), '2026-01-02 a b.md');
});
test('markdown: emphasis markers must hug their text', () => {
  assert.equal(markdownToPlain('calc 2 * 3 * 4 and a_b_c and *em*'), 'calc 2 * 3 * 4 and a_b_c and em');
  const html = renderMarkdown('2 * 3 * 4 and *em* and snake_case_name');
  assert.doesNotMatch(html, /<em> 3 <\/em>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /snake_case_name/);
});
test('markdown: fenced code inside a list item stays inside the item', () => {
  const html = renderMarkdown('1. Install:\n\n   ```bash\n   npm i\n   ```\n2. Run\n\nAfter');
  assert.match(html, /<ol><li>Install:<pre data-lang="bash"><code class="language-bash">npm i<\/code><\/pre><\/li><li>Run<\/li><\/ol>/);
  assert.match(html, /<p>After<\/p>/);
});
test('markdown: autolink keeps query strings', () => {
  assert.match(renderMarkdown('<https://x.com/?a=1&b=2>'), /<a href="https:\/\/x.com\/\?a=1&amp;b=2"/);
});
test('markdown: javascript: source url is not emitted as a link', () => {
  const html = toHtml({ ...conv, url: 'javascript:alert(1)' });
  assert.doesNotMatch(html, /href="javascript:/);
});
test('similarity: tokenizer handles non-Latin text', () => {
  assert.ok(tokenize('طراحی محدودکننده نرخ').includes('محدودکننده'));
  assert.ok(tokenize('Обучение модели').includes('обучение'));
  assert.ok(tokenize('東京の天気').includes('東京'));
  assert.deepEqual(tokenize('2024 the and'), []);
});
test('idForUrl merges aliases of the same chat but keeps the canonical id', () => {
  assert.equal(idForUrl('https://chatgpt.com/c/abc'), 'conv_b7mr0y', 'unchanged from earlier versions');
  assert.equal(idForUrl('https://chat.openai.com/c/abc'), idForUrl('https://chatgpt.com/c/abc'));
  assert.equal(idForUrl('https://chatgpt.com/g/g-p-123/c/abc'), idForUrl('https://chatgpt.com/c/abc'));
  assert.notEqual(idForUrl('https://chatgpt.com/c/abc'), idForUrl('https://chatgpt.com/c/abd'));
});
await atest('storage: a renamed title survives re-saves and live sync', async () => {
  mem.clear();
  const url = 'https://chatgpt.com/c/title1';
  const meta = await store.saveConversation({ ...conv, id: undefined, url, title: 'Page title' });
  await store.updateConversation(meta.id, { title: 'My name' });
  const again = await store.saveConversation({ ...conv, id: undefined, url, title: 'Page title', messages: [...conv.messages, { role: 'user', content: 'x' }] });
  assert.equal(again.title, 'My name');
  assert.equal(again.messageCount, 3);
});
await atest('storage: a visible-only capture never replaces a full one', async () => {
  mem.clear();
  const url = 'https://chatgpt.com/c/full1';
  const msgs = [1, 2, 3, 4].map((i) => ({ role: i % 2 ? 'user' : 'assistant', content: `m${i}` }));
  const meta = await store.saveConversation({ ...conv, id: undefined, url, captureLevel: 'full', messages: msgs });
  assert.equal(meta.captureLevel, 'full');
  // fewer messages (virtualised page): keep the stored messages and the badge
  const shrunk = await store.saveConversation({ ...conv, id: undefined, url, captureLevel: 'quick', messages: msgs.slice(2) });
  assert.equal(shrunk.captureLevel, 'full');
  assert.equal((await store.getConversation(meta.id)).messages.length, 4);
  // more messages (new replies): accept them, still a full capture
  const grown = await store.saveConversation({ ...conv, id: undefined, url, captureLevel: 'quick', messages: [...msgs, { role: 'user', content: 'm5' }] });
  assert.equal(grown.captureLevel, 'full');
  assert.equal(grown.messageCount, 5);
});
await atest('storage: deleting every prompt does not resurrect the defaults', async () => {
  mem.clear();
  for (const t of await store.listTemplates()) await store.deleteTemplate(t.id);
  assert.equal((await store.listTemplates()).length, 0);
  await store.resetTemplates();
  assert.equal((await store.listTemplates()).length, store.DEFAULT_TEMPLATES.length);
});
await atest('storage: clearAllData removes legacy keys and does not re-migrate', async () => {
  mem.clear();
  mem.set('conversationBridge.conversations', [{ ...conv, id: 'old', url: 'https://claude.ai/chat/legacy' }]);
  await store.migrate();
  assert.equal((await store.listConversations()).length, 1);
  await store.clearAllData();
  assert.equal((await store.listConversations()).length, 0);
  assert.ok(!mem.has('conversationBridge.conversations'), 'legacy data removed');
  await store.migrate();
  assert.equal((await store.listConversations()).length, 0, 'nothing comes back after the next update');
});
await atest('storage: batch import writes the index once, skips junk, keeps settings unless asked', async () => {
  mem.clear();
  await store.updateSettings({ theme: 'dark' });
  let indexWrites = 0;
  const origSet = chrome.storage.local.set;
  chrome.storage.local.set = async (obj) => {
    if ('cb.index' in obj) indexWrites += 1;
    return origSet(obj);
  };
  const many = Array.from({ length: 120 }, (_, i) => ({ ...conv, id: undefined, url: `https://chatgpt.com/c/bulk${i}`, title: `Bulk ${i}` }));
  const n = await store.importBackup({
    conversations: [...many, null, { title: 'no messages' }, 'junk'],
    templates: [{ id: 't1', title: 'T', body: 'B' }, 'junk', { title: '' }],
    workspaces: [{ id: 'w1', title: 'W' }, 42],
    settings: { theme: 'light', downloadSubfolder: 123, notASetting: true },
  });
  chrome.storage.local.set = origSet;
  assert.equal(n, 120);
  assert.equal(indexWrites, 1);
  assert.equal((await store.listConversations()).length, 120);
  assert.equal((await store.listTemplates()).filter((t) => t.id === 't1').length, 1);
  assert.equal((await store.listWorkspaces()).length, 1);
  assert.equal((await store.getSettings()).theme, 'dark', 'settings untouched by default');
  await store.importBackup({ conversations: [], settings: { theme: 'light', downloadSubfolder: 123, notASetting: true } }, { applySettings: true });
  const s = await store.getSettings();
  assert.equal(s.theme, 'light');
  assert.equal(s.downloadSubfolder, store.DEFAULT_SETTINGS.downloadSubfolder, 'wrong type ignored');
  assert.ok(!('notASetting' in s));
});
await atest('storage: bulk delete moves everything to the trash in one pass', async () => {
  mem.clear();
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push((await store.saveConversation({ ...conv, id: undefined, url: `https://chatgpt.com/c/del${i}` })).id);
  await store.deleteConversations(ids);
  assert.equal((await store.listConversations()).length, 0);
  assert.equal((await store.listTrash()).length, 3);
  assert.ok(!mem.has(store.KEYS.conv(ids[0])));
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
