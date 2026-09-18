// Library view: saved conversations with search, filters, bulk actions.

import { h, button, select, empty, toast, confirm, prompt, modal, pickFile, readFile, copyText } from '../dom.js';
import { icon } from '../icons.js';
import * as store from '../../lib/storage.js';
import { PLATFORMS, platformLabel, relativeTime, plural, STAGES, parseTags } from '../../lib/util.js';
import { detectImport } from '../../lib/importers.js';
import { exportMany, exportOne, notifyExport, sendMessage } from '../actions.js';
import { toMarkdown } from '../../lib/exporters.js';

const SORTS = [
  ['updated', 'Recently updated'],
  ['saved', 'Recently saved'],
  ['created', 'Newest chat'],
  ['title', 'Title A–Z'],
  ['messages', 'Most messages'],
  ['platform', 'Platform'],
];

// Content search cache: id -> { updatedAt, text }. Entries are refreshed when the index says a
// conversation changed (saves from Capture, live sync…), not only when the count changes.
let fullTextCache = new Map();
let fullTextLoading = null;

export function invalidateSearchCache() {
  fullTextCache = new Map();
}

export function renderLibrary(ctx) {
  const { state } = ctx;
  const lib = state.library;
  const list = filterAndSort(state.index, lib);
  const visible = list.slice(0, lib.limit);
  const selected = new Set([...lib.selected].filter((id) => state.index.some((m) => m.id === id)));
  lib.selected = selected;

  const search = h(
    'div',
    { class: 'search' },
    icon('search', 14),
    h('input', {
      id: 'lib-search',
      class: 'input',
      placeholder: 'Search titles, tags, notes, content…  ( / )',
      value: lib.query,
      'aria-label': 'Search library',
      onInput: (e) => {
        lib.query = e.target.value;
        lib.limit = 40;
        ensureFullText(ctx).then((loaded) => loaded && ctx.render());
        ctx.render();
      },
    }),
    lib.query ? button({ iconName: 'x', className: 'btn icon sm clear', title: 'Clear', onClick: () => ((lib.query = ''), ctx.render()) }) : null,
  );

  const filters = h(
    'div',
    { class: 'filters' },
    select({
      value: lib.platform,
      className: 'select sm',
      ariaLabel: 'Platform filter',
      options: [['', 'All platforms'], ...Object.entries(PLATFORMS).filter(([id]) => id !== 'other' || state.index.some((m) => m.platform === 'other')).map(([id, p]) => [id, p.label])],
      onChange: (v) => ((lib.platform = v), ctx.render()),
    }),
    select({
      value: lib.stage,
      className: 'select sm',
      ariaLabel: 'Stage filter',
      options: [['', 'Any stage'], ...Object.entries(STAGES)],
      onChange: (v) => ((lib.stage = v), ctx.render()),
    }),
    select({ value: lib.sort, className: 'select sm', ariaLabel: 'Sort', options: SORTS, onChange: (v) => ((lib.sort = v), ctx.render()) }),
    button({ iconName: 'star', className: `btn icon sm ${lib.favorite ? 'active' : ''}`, title: 'Favorites only', onClick: () => ((lib.favorite = !lib.favorite), ctx.render()) }),
  );

  const tagFilter = lib.tag
    ? h('div', { class: 'row small' }, h('span', { class: 'muted' }, 'Tag:'), h('span', { class: 'chip tag' }, `#${lib.tag}`, h('button', { class: 'x', onClick: () => ((lib.tag = ''), ctx.render()), 'aria-label': 'Clear tag filter' }, '×')))
    : null;

  const toolbar = h(
    'div',
    { class: 'row between wrap small muted' },
    h('span', {}, `${plural(list.length, 'conversation')}${list.length !== state.index.length ? ` of ${state.index.length}` : ''}`),
    h(
      'div',
      { class: 'row', style: { gap: '2px' } },
      h('button', { class: 'text-btn muted', onClick: () => ((lib.selected = new Set(list.map((m) => m.id))), ctx.render()) }, 'Select all'),
      button({ iconName: 'upload', className: 'btn icon sm', title: 'Import conversations or a backup', onClick: () => importFile(ctx) }),
      button({ iconName: 'download', className: 'btn icon sm', title: 'Export the whole library', onClick: () => exportAll(ctx, list) }),
    ),
  );

  const cards = visible.map((meta) => renderCard(ctx, meta, selected.has(meta.id)));
  const more =
    list.length > visible.length
      ? button({ label: `Show ${Math.min(40, list.length - visible.length)} more`, className: 'btn block ghost', onClick: () => ((lib.limit += 40), ctx.render()) })
      : null;

  const content = state.index.length
    ? cards.length
      ? [...cards, more]
      : empty({ iconName: 'search', title: 'No matches', text: 'Try another search or clear the filters.', action: button({ label: 'Clear filters', onClick: () => (Object.assign(lib, { query: '', platform: '', stage: '', favorite: false, tag: '' }), ctx.render()) }) })
    : empty({
        iconName: 'archive',
        title: 'Your library is empty',
        text: 'Save a conversation from the Capture tab, or import a backup or an official ChatGPT / Claude export.',
        action: h('div', { class: 'row', style: { justifyContent: 'center' } }, button({ label: 'Capture', iconName: 'zap', className: 'btn primary', onClick: () => ctx.goto('capture') }), button({ label: 'Import', iconName: 'upload', onClick: () => importFile(ctx) })),
      });

  return h('div', { class: 'stack fade', style: { gap: '10px' } }, search, filters, tagFilter, toolbar, content, selected.size ? renderBulkBar(ctx, selected) : null);
}

function filterAndSort(index, lib) {
  const q = lib.query.trim().toLowerCase();
  let list = index.filter((m) => {
    if (lib.platform && m.platform !== lib.platform) return false;
    if (lib.stage && m.workflowStage !== lib.stage) return false;
    if (lib.favorite && !m.favorite) return false;
    if (lib.tag && !m.tags.some((t) => t.toLowerCase() === lib.tag.toLowerCase())) return false;
    if (!q) return true;
    const hay = `${m.title} ${m.platform} ${m.notes} ${m.tags.join(' ')} ${(m.autoTags ?? []).join(' ')} ${m.preview}`.toLowerCase();
    if (hay.includes(q)) return true;
    return fullTextCache.get(m.id)?.text.includes(q) ?? false;
  });
  const by = {
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    saved: (a, b) => (b.savedAt ?? b.updatedAt).localeCompare(a.savedAt ?? a.updatedAt),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    title: (a, b) => a.title.localeCompare(b.title),
    messages: (a, b) => b.messageCount - a.messageCount,
    platform: (a, b) => a.platform.localeCompare(b.platform) || b.updatedAt.localeCompare(a.updatedAt),
  }[lib.sort] ?? ((a, b) => 0);
  list = list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || by(a, b));
  return list;
}

/** Load message text for conversations the cache does not have or has an old version of. Resolves true when something was loaded. */
async function ensureFullText(ctx) {
  if (fullTextLoading) return fullTextLoading;
  const stale = ctx.state.index.filter((m) => fullTextCache.get(m.id)?.updatedAt !== m.updatedAt).map((m) => m.id);
  if (!stale.length) return false;
  fullTextLoading = (async () => {
    try {
      const convs = await store.getConversations(stale);
      for (const c of convs) fullTextCache.set(c.id, { updatedAt: c.updatedAt, text: c.messages.map((m) => m.content).join('\n').toLowerCase() });
      return true;
    } finally {
      fullTextLoading = null;
    }
  })();
  return fullTextLoading;
}

function renderCard(ctx, meta, isSelected) {
  const { state } = ctx;
  const lib = state.library;
  const platform = PLATFORMS[meta.platform] ?? PLATFORMS.other;
  const toggleSel = (checked) => {
    if (checked) lib.selected.add(meta.id);
    else lib.selected.delete(meta.id);
    ctx.render();
  };
  const tags = meta.tags.slice(0, 5).map((t) => h('button', { class: 'chip tag clickable', title: `Filter by #${t}`, onClick: () => ((lib.tag = t), ctx.render()) }, `#${t}`));
  const topics = (meta.autoTags ?? []).slice(0, 3).map((t) => h('span', { class: 'chip topic', title: 'Auto-detected topic' }, t));
  return h(
    'article',
    { class: `card conv-card ${isSelected ? 'selected' : ''}` },
    h('input', { type: 'checkbox', checked: isSelected, 'aria-label': `Select ${meta.title}`, onChange: (e) => toggleSel(e.target.checked) }),
    h(
      'div',
      { class: 'grow' },
      h('button', { class: 'title clamp-2', onClick: () => ctx.openReader(meta.id) }, meta.pinned ? icon('pin', 11) : null, meta.title),
      h(
        'div',
        { class: 'meta' },
        h('span', { class: 'row', style: { gap: '4px' } }, h('span', { class: 'platform-dot', style: { background: platform.color } }), platformLabel(meta.platform)),
        h('span', { title: new Date(meta.updatedAt).toLocaleString() }, relativeTime(meta.updatedAt)),
        h('span', {}, plural(meta.messageCount, 'msg')),
        meta.captureLevel === 'full' ? h('span', { class: 'badge ok' }, 'Full') : null,
        meta.workflowStage && meta.workflowStage !== 'inbox' ? h('span', { class: 'badge neutral' }, STAGES[meta.workflowStage]) : null,
        meta.liveSync ? h('span', { class: 'badge ok', title: 'Live sync on' }, icon('activity', 10)) : null,
      ),
      meta.preview ? h('div', { class: 'preview clamp-2' }, meta.preview) : null,
      tags.length || topics.length ? h('div', { class: 'chips' }, ...tags, ...topics) : null,
    ),
    h(
      'div',
      { class: 'side' },
      button({
        iconName: 'star',
        className: `btn icon sm ${meta.favorite ? 'active' : ''}`,
        title: meta.favorite ? 'Remove from favorites' : 'Add to favorites',
        onClick: async () => {
          await store.updateConversation(meta.id, { favorite: !meta.favorite });
          await ctx.reload();
          ctx.render();
        },
      }),
      button({ iconName: 'more', className: 'btn icon sm', title: 'More actions', onClick: (e) => showCardMenu(ctx, meta, e.currentTarget) }),
    ),
  );
}

function showCardMenu(ctx, meta, anchor) {
  const { state } = ctx;
  const items = [
    ['Open', 'eye', () => ctx.openReader(meta.id)],
    ['Copy as Markdown', 'copy', async () => copyText(toMarkdown(await store.getConversation(meta.id), exportOpts(state))).then(() => toast('Copied'))],
    ['Download Markdown', 'download', async () => exportOne(await store.getConversation(meta.id), 'markdown', exportOpts(state), state.settings).then(notifyExport)],
    ['Download JSON', 'fileText', async () => exportOne(await store.getConversation(meta.id), 'json', exportOpts(state), state.settings).then(notifyExport)],
    ['Print / PDF', 'printer', async () => exportOne(await store.getConversation(meta.id), 'pdf', exportOpts(state), state.settings).then(notifyExport)],
    ['Transfer to ' + platformLabel(state.transfer.target), 'send', async () => transferConversation(ctx, await store.getConversation(meta.id))],
    [meta.pinned ? 'Unpin' : 'Pin to top', 'pin', async () => (await store.updateConversation(meta.id, { pinned: !meta.pinned }), await ctx.reload(), ctx.render())],
    ['Edit tags', 'tag', async () => editTags(ctx, meta)],
    meta.url ? ['Open original chat', 'externalLink', () => chrome.tabs.create({ url: meta.url })] : null,
    ['Delete', 'trash', () => deleteOne(ctx, meta), true],
  ].filter(Boolean);
  const menu = h(
    'div',
    { class: 'card', style: { position: 'absolute', zIndex: 50, padding: '4px', minWidth: '190px', boxShadow: 'var(--shadow-lg)' }, role: 'menu' },
    items.map(([label, ic, fn, danger]) =>
      h(
        'button',
        {
          class: `btn ghost block ${danger ? 'danger' : ''}`,
          style: { justifyContent: 'flex-start' },
          role: 'menuitem',
          onClick: () => {
            close();
            fn();
          },
        },
        icon(ic, 14),
        h('span', {}, label),
      ),
    ),
  );
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.right = `${Math.max(8, document.documentElement.clientWidth - rect.right)}px`;
  const close = () => {
    menu.remove();
    document.removeEventListener('click', onDoc, true);
    document.removeEventListener('keydown', onKey);
  };
  const onDoc = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.body.append(menu);
  setTimeout(() => {
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey);
  }, 0);
}

export function exportOpts(state, extra = {}) {
  return {
    frontmatter: state.settings.frontmatter,
    includeTimestamps: state.settings.includeTimestamps,
    includeSystemMessages: state.settings.includeSystemMessages,
    ...extra,
  };
}

export async function transferConversation(ctx, conv, instruction) {
  const { state } = ctx;
  const body = instruction ?? 'Continue this conversation from here. Preserve the useful context and take the next best step.';
  const text = `${toMarkdown(conv, exportOpts(state))}\n\n---\n\n${body}`;
  toast(`Opening ${platformLabel(state.transfer.target)}…`);
  const res = await sendMessage({ type: 'TRANSFER_TO_LLM', destination: state.transfer.target, text, autoSend: state.settings.autoSendOnTransfer });
  if (res.ok) toast(res.data.sent ? `Sent to ${platformLabel(state.transfer.target)}` : 'Pasted — press Send when ready');
  else toast(res.error, { type: 'error', duration: 6000 });
}

export async function editTags(ctx, meta) {
  const value = await prompt({ title: 'Edit tags', text: 'Separate tags with commas.', value: meta.tags.join(', '), placeholder: 'research, project-x' });
  if (value === null) return;
  await store.updateConversation(meta.id, { tags: parseTags(value) });
  invalidateSearchCache();
  await ctx.reload();
  ctx.render();
}

export async function deleteOne(ctx, meta) {
  const { state } = ctx;
  if (state.settings.confirmDelete) {
    const ok = await confirm({ title: 'Delete conversation?', text: `"${meta.title}" will move to the trash. You can restore it from Settings for a while.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
  }
  await store.deleteConversation(meta.id);
  state.library.selected.delete(meta.id);
  invalidateSearchCache();
  await ctx.reload();
  if (state.view === 'reader' && state.reader.id === meta.id) ctx.goto('library');
  else ctx.render();
  toast('Conversation deleted', {
    action: {
      label: 'Undo',
      onClick: async () => {
        await store.restoreFromTrash(meta.id);
        await ctx.reload();
        ctx.render();
      },
    },
  });
}

function renderBulkBar(ctx, selected) {
  const { state } = ctx;
  const ids = [...selected];
  const getConvs = () => store.getConversations(ids);
  const done = (msg) => {
    state.library.selected = new Set();
    ctx.render();
    if (msg) toast(msg);
  };
  return h(
    'div',
    { class: 'bulkbar fade' },
    h('span', { class: 'count' }, `${ids.length} selected`),
    button({ label: 'MD', className: 'btn sm', title: 'Download one Markdown file', onClick: async () => (await exportMany(await getConvs(), 'markdown', exportOpts(state), state.settings), done('Exported Markdown')) }),
    button({ label: 'JSON', className: 'btn sm', title: 'Download one JSON file', onClick: async () => (await exportMany(await getConvs(), 'json', exportOpts(state), state.settings), done('Exported JSON')) }),
    button({
      label: 'ZIP',
      className: 'btn sm',
      title: 'Download a ZIP with one file per conversation',
      onClick: async () => (await exportMany(await getConvs(), 'zip', exportOpts(state), state.settings), done('Exported ZIP')),
    }),
    button({
      iconName: 'tag',
      className: 'btn sm icon',
      title: 'Add tags to selected',
      onClick: async () => {
        const value = await prompt({ title: `Add tags to ${ids.length} conversations`, placeholder: 'tag1, tag2' });
        if (value === null) return;
        const tags = parseTags(value);
        for (const id of ids) {
          const meta = state.index.find((m) => m.id === id);
          await store.updateConversation(id, { tags: Array.from(new Set([...(meta?.tags ?? []), ...tags])) });
        }
        invalidateSearchCache();
        await ctx.reload();
        done('Tags added');
      },
    }),
    state.workspaces.length
      ? button({
          iconName: 'layers',
          className: 'btn sm icon',
          title: 'Add to a workflow',
          onClick: async () => {
            const sel = select({ value: state.workspaces[0].id, options: state.workspaces.map((w) => [w.id, w.title]) });
            modal({
              title: 'Add to workflow',
              body: sel,
              actions: [
                { label: 'Cancel' },
                {
                  label: 'Add',
                  primary: true,
                  onClick: async () => {
                    for (const id of ids) await store.updateConversation(id, { workspaceId: sel.value, workflowStage: 'active' });
                    await ctx.reload();
                    done('Added to workflow');
                  },
                },
              ],
            });
          },
        })
      : null,
    button({
      iconName: 'trash',
      className: 'btn sm icon',
      title: 'Delete selected',
      onClick: async () => {
        const ok = await confirm({
          title: `Delete ${ids.length} conversations?`,
          text: ids.length > store.TRASH_LIMIT ? `The trash only keeps the last ${store.TRASH_LIMIT} deletions, so ${ids.length - store.TRASH_LIMIT} of these cannot be restored afterwards.` : 'They will move to the trash for a while.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await store.deleteConversations(ids);
        invalidateSearchCache();
        await ctx.reload();
        done(`Deleted ${ids.length}`);
      },
    }),
    button({ iconName: 'x', className: 'btn sm icon', title: 'Clear selection', onClick: () => done() }),
  );
}

async function exportAll(ctx, list) {
  const { state } = ctx;
  const convs = () => store.getConversations(list.map((m) => m.id));
  modal({
    title: `Export ${plural(list.length, 'conversation')}`,
    body: h('p', { class: 'muted small', style: { margin: 0 } }, 'Exports the conversations currently shown (respecting your search and filters).'),
    actions: [
      { label: 'Markdown', iconName: 'fileText', onClick: async () => (await exportMany(await convs(), 'markdown', exportOpts(state), state.settings), toast('Exported')) },
      { label: 'JSON', iconName: 'fileText', onClick: async () => (await exportMany(await convs(), 'json', exportOpts(state), state.settings), toast('Exported')) },
      {
        label: 'ZIP',
        iconName: 'package',
        primary: true,
        onClick: async () => {
          await exportMany(await convs(), 'zip', exportOpts(state), state.settings);
          toast('Exported ZIP');
        },
      },
    ],
  });
}

let importing = false;

/** Ask whether a backup's settings should replace the current ones. Resolves null when cancelled. */
function askImportOptions(count) {
  return new Promise((resolve) => {
    let decided = false;
    modal({
      title: 'Restore backup',
      body: h(
        'p',
        { class: 'muted small', style: { margin: 0 } },
        `${plural(count, 'conversation')}, prompts and workflows will be merged into your library. The backup also contains settings (theme, export defaults, download folder…) — keep yours or use the ones in the file?`,
      ),
      onClose: () => !decided && resolve(null),
      actions: [
        { label: 'Cancel', onClick: () => (decided = true) && resolve(null) },
        { label: 'Keep my settings', primary: true, onClick: () => (decided = true) && resolve({ applySettings: false }) },
        { label: 'Use backup settings', onClick: () => (decided = true) && resolve({ applySettings: true }) },
      ],
    });
  });
}

export async function importFile(ctx) {
  if (importing) {
    toast('An import is already running', { type: 'error' });
    return;
  }
  const file = await pickFile('application/json,.json');
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await readFile(file));
  } catch {
    toast('That file is not valid JSON', { type: 'error' });
    return;
  }
  const detected = detectImport(data);
  if (detected.kind === 'unknown') {
    toast('Unrecognised file. Expected a Conversation Bridge backup or an official ChatGPT / Claude export.', { type: 'error', duration: 6000 });
    return;
  }
  const total = detected.conversations.length;
  let options = { applySettings: false };
  if (detected.backup?.settings && typeof detected.backup.settings === 'object') {
    options = await askImportOptions(total);
    if (!options) return;
  }
  importing = true;
  const progress = h('p', { class: 'muted small', style: { margin: 0 } }, `Importing ${plural(total, 'conversation')}…`);
  const { close } = modal({ title: 'Importing', body: [progress, h('div', { class: 'row', style: { justifyContent: 'center', padding: '8px 0 0' } }, h('span', { class: 'spinner' }))] });
  try {
    const onProgress = (done) => {
      progress.textContent = `Importing ${done.toLocaleString()} of ${total.toLocaleString()} conversations…`;
    };
    const count = await store.importBackup(detected.backup ?? detected.conversations, { ...options, onProgress });
    invalidateSearchCache();
    await ctx.reload();
    if (options.applySettings) {
      await ctx.reloadSettings();
      ctx.applyTheme();
    }
    ctx.render();
    toast(`Imported ${plural(count, 'conversation')}`);
  } catch (err) {
    toast(`Import failed: ${err?.message ?? err}`, { type: 'error', duration: 6000 });
  } finally {
    importing = false;
    close();
  }
}

