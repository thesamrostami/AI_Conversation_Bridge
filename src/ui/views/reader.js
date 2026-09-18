// Reader view: a single conversation, rendered, searchable and editable.

import { h, button, select, toast, confirm, copyText, toggle } from '../dom.js';
import { icon } from '../icons.js';
import * as store from '../../lib/storage.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { exportConversation } from '../../lib/exporters.js';
import { PLATFORMS, platformLabel, formatDate, wordCount, estimateTokens, plural, STAGES, PRIORITIES, RETENTION, parseTags, escapeHtml, safeHttpUrl } from '../../lib/util.js';
import { relatedConversations } from '../../lib/similarity.js';
import { exportOne, notifyExport, sendMessage } from '../actions.js';
import { exportOpts, transferConversation, deleteOne, invalidateSearchCache } from './library.js';
import { renderTransfer } from './capture.js';

export function renderReader(ctx) {
  const { state } = ctx;
  const r = state.reader;
  const back = button({ label: 'Back', iconName: 'arrowLeft', className: 'btn ghost sm', onClick: () => ctx.goto(state.previousView === 'reader' ? 'library' : state.previousView) });
  if (r.loading) return h('div', { class: 'stack' }, back, h('div', { class: 'row', style: { justifyContent: 'center', padding: '24px' } }, h('span', { class: 'spinner' })));
  const conv = r.conv;
  if (!conv) return h('div', { class: 'stack' }, back, h('div', { class: 'notice warn' }, icon('alert'), h('span', {}, 'This conversation is no longer in the library.')));

  const isSaved = state.index.some((m) => m.id === conv.id);
  // A transient reader shows a page capture. Even when that chat is in the library, this object
  // is not the library copy, so editing tags/notes/messages through it would clobber the saved one.
  const editable = isSaved && !r.transient;
  const platform = PLATFORMS[conv.platform] ?? PLATFORMS.other;
  const text = conv.messages.map((m) => m.content).join('\n');
  const q = r.query.trim().toLowerCase();
  const hits = q ? conv.messages.filter((m) => m.content.toLowerCase().includes(q)) : [];

  const titleInput = h('textarea', {
    class: 'reader-title',
    rows: 1,
    value: conv.title,
    'aria-label': 'Conversation title',
    disabled: !editable,
    onInput: (e) => autoGrow(e.target),
    onChange: async (e) => {
      const title = e.target.value.trim() || 'Untitled conversation';
      await store.updateConversation(conv.id, { title });
      conv.title = title;
      invalidateSearchCache();
      await ctx.reload();
      toast('Title updated');
    },
  });
  setTimeout(() => autoGrow(titleInput), 0);

  const meta = h(
    'div',
    { class: 'row wrap small muted', style: { gap: '4px 8px' } },
    h('span', { class: 'row', style: { gap: '4px' } }, h('span', { class: 'platform-dot', style: { background: platform.color } }), platformLabel(conv.platform)),
    h('span', {}, formatDate(conv.createdAt)),
    h('span', {}, `${plural(conv.messages.length, 'message')} · ${wordCount(text).toLocaleString()} words · ~${estimateTokens(text).toLocaleString()} tokens`),
    conv.captureLevel === 'full' ? h('span', { class: 'badge ok' }, 'Full thread') : null,
    safeHttpUrl(conv.url) ? h('a', { href: safeHttpUrl(conv.url), target: '_blank', rel: 'noopener noreferrer', class: 'row', style: { gap: '3px' } }, icon('externalLink', 11), 'Open original') : null,
  );

  const exportBtn = (label, format, iconName = 'download') =>
    button({ label, iconName, className: 'btn sm', onClick: async () => notifyExport(await exportOne(conv, format, exportOpts(state), state.settings)) });
  const saveBtn = button({
    label: isSaved ? 'Update saved copy' : 'Save',
    iconName: 'save',
    className: 'btn sm primary',
    onClick: async () => {
      const saved = await store.saveConversation({ ...conv, id: isSaved ? conv.id : undefined });
      conv.id = saved.id;
      state.reader.id = saved.id;
      state.reader.transient = false;
      state.reader.conv = await store.getConversation(saved.id);
      if (state.current?.conv?.url === conv.url) state.current.savedMeta = saved;
      await ctx.reload();
      ctx.render();
      toast(isSaved ? 'Library copy updated' : 'Saved to your library');
    },
  });
  const actionRow = h(
    'div',
    { class: 'row wrap', style: { gap: '6px' } },
    button({ label: 'Copy', iconName: 'copy', className: 'btn sm', onClick: async () => (await copyText(exportConversation(conv, 'markdown', exportOpts(state))), toast('Copied as Markdown')) }),
    exportBtn('MD', 'markdown'),
    exportBtn('HTML', 'html'),
    exportBtn('JSON', 'json'),
    exportBtn('PDF', 'pdf', 'printer'),
    editable ? button({ iconName: 'star', className: `btn icon sm ${conv.favorite ? 'active' : ''}`, title: 'Favorite', onClick: async () => update(ctx, conv, { favorite: !conv.favorite }) }) : saveBtn,
    editable ? button({ iconName: 'trash', className: 'btn icon sm', title: 'Delete', onClick: () => deleteOne(ctx, conv) }) : null,
  );

  // Page capture of a chat that is also in the library: offer the editable copy.
  const transientNotice =
    r.transient && isSaved
      ? h(
          'div',
          { class: 'notice', style: { alignItems: 'center' } },
          icon('info', 14),
          h('span', { class: 'grow small' }, 'Showing the messages currently on the page. Tags, notes and edits live on the saved copy.'),
          button({ label: 'Open saved copy', className: 'btn sm', onClick: () => ctx.openReader(conv.id) }),
        )
      : null;

  const transfer = renderTransfer(ctx, () => `${exportConversation(conv, 'markdown', exportOpts(state))}\n\n---\n\nContinue this conversation from here. Preserve the useful context and take the next best step.`);

  const search = h(
    'div',
    { class: 'search' },
    icon('search', 14),
    h('input', {
      id: 'reader-search',
      class: 'input',
      placeholder: 'Find in conversation…',
      value: r.query,
      'aria-label': 'Find in conversation',
      onInput: (e) => {
        r.query = e.target.value;
        ctx.render();
      },
    }),
    q ? h('span', { class: 'small muted', style: { position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)' } }, plural(hits.length, 'hit')) : null,
  );

  const messages = conv.messages.map((m, i) => renderMessage(ctx, conv, m, i, q, editable));

  return h(
    'div',
    { class: 'stack fade', style: { gap: '10px' } },
    h('div', { class: 'row between' }, back, isSaved ? h('span', { class: 'small faint' }, `Saved ${formatDate(conv.savedAt ?? conv.updatedAt)}`) : h('span', { class: 'badge warn' }, 'Not saved yet')),
    transientNotice,
    h('div', { class: 'reader-head' }, titleInput, meta),
    actionRow,
    transfer,
    editable ? renderMetadata(ctx, conv) : null,
    search,
    ...messages,
    isSaved ? renderRelated(ctx, conv) : null,
  );
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

async function update(ctx, conv, patch) {
  const meta = await store.updateConversation(conv.id, patch);
  if (meta) Object.assign(conv, patch, { autoTags: meta.autoTags });
  invalidateSearchCache();
  await ctx.reload();
  ctx.render();
}

function renderMetadata(ctx, conv) {
  const { state } = ctx;
  const tagInput = h('input', {
    id: 'reader-tag-input',
    class: 'input sm',
    placeholder: 'Add tag…',
    'aria-label': 'Add tag',
    onKeyDown: async (e) => {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      const tags = parseTags(e.target.value);
      if (!tags.length) return;
      e.target.value = '';
      await update(ctx, conv, { tags: Array.from(new Set([...conv.tags, ...tags])) });
    },
  });
  const tags = h(
    'div',
    { class: 'chips' },
    conv.tags.map((t) => h('span', { class: 'chip tag' }, `#${t}`, h('button', { class: 'x', 'aria-label': `Remove tag ${t}`, onClick: () => update(ctx, conv, { tags: conv.tags.filter((x) => x !== t) }) }, '×'))),
    (conv.autoTags ?? [])
      .filter((t) => !conv.tags.includes(t))
      .slice(0, 4)
      .map((t) => h('button', { class: 'chip topic clickable', title: 'Suggested topic — click to add as a tag', onClick: () => update(ctx, conv, { tags: [...conv.tags, t] }) }, '+ ', t)),
  );
  const notes = h('textarea', {
    class: 'textarea',
    placeholder: 'Notes — why this chat matters, what to do next…',
    value: conv.notes ?? '',
    'aria-label': 'Notes',
    onChange: (e) => update(ctx, conv, { notes: e.target.value }),
  });
  const selects = h(
    'div',
    { class: 'grid-3' },
    select({ value: conv.workflowStage ?? 'inbox', className: 'select sm', ariaLabel: 'Stage', options: Object.entries(STAGES), onChange: (v) => update(ctx, conv, { workflowStage: v }) }),
    select({ value: conv.priority ?? 'normal', className: 'select sm', ariaLabel: 'Priority', options: Object.entries(PRIORITIES), onChange: (v) => update(ctx, conv, { priority: v }) }),
    select({ value: conv.retentionLevel ?? 'working', className: 'select sm', ariaLabel: 'Retention', options: Object.entries(RETENTION), onChange: (v) => update(ctx, conv, { retentionLevel: v }) }),
  );
  const workspace = select({
    value: conv.workspaceId ?? '',
    className: 'select sm',
    ariaLabel: 'Workflow',
    options: [['', 'No workflow'], ...state.workspaces.map((w) => [w.id, w.title])],
    onChange: (v) => update(ctx, conv, { workspaceId: v || undefined }),
  });
  const live = h(
    'div',
    { class: 'row between' },
    h('span', { class: 'small' }, 'Live sync while the chat tab is open'),
    toggle({
      checked: Boolean(conv.liveSync),
      ariaLabel: 'Live sync',
      onChange: async (checked) => {
        if (checked && !state.settings.liveSync) {
          await store.updateSettings({ liveSync: true });
          await ctx.reloadSettings();
          sendMessage({ type: 'LIVE_SYNC_CHANGED' });
        }
        return update(ctx, conv, { liveSync: checked });
      },
    }),
  );
  return h(
    'details',
    { class: 'collapsible panel', open: true },
    h('summary', {}, icon('chevronRight', 13, 'chev'), 'Tags, notes & organisation'),
    h('div', { class: 'stack', style: { marginTop: '6px' } }, tags, tagInput, notes, selects, workspace, live),
  );
}

function renderMessage(ctx, conv, m, i, q, editable) {
  let html = renderMarkdown(m.content);
  if (q) html = highlight(html, q);
  const hit = q && m.content.toLowerCase().includes(q);
  const roleLabel = m.role === 'user' ? 'You' : m.role === 'system' ? 'System' : platformLabel(conv.platform);
  return h(
    'article',
    { class: `message ${m.role} ${hit ? 'hit' : ''}`, id: `msg-${i}` },
    h(
      'div',
      { class: 'head' },
      h('span', { class: 'role' }, `${roleLabel} · ${i + 1}`),
      h(
        'div',
        { class: 'row', style: { gap: '0' } },
        button({ iconName: 'copy', className: 'btn icon sm', title: 'Copy message', onClick: async () => (await copyText(m.content), toast('Message copied')) }),
        button({
          iconName: 'send',
          className: 'btn icon sm',
          title: 'Paste this message into the active chat composer',
          onClick: async () => {
            const res = await sendMessage({ type: 'INSERT_INTO_ACTIVE_TAB', text: m.content, autoSend: false });
            toast(res.ok ? 'Pasted into the active chat' : res.error, { type: res.ok ? 'info' : 'error' });
          },
        }),
        editable
          ? button({
              iconName: 'trash',
              className: 'btn icon sm',
              title: 'Remove this message from the saved copy',
              onClick: async () => {
                const ok = await confirm({ title: 'Remove message?', text: 'Only your saved copy changes; the original chat is untouched.', confirmLabel: 'Remove', danger: true });
                if (!ok) return;
                const next = conv.messages.filter((x) => x.id !== m.id);
                await store.replaceMessages(conv.id, next);
                conv.messages = next;
                invalidateSearchCache();
                await ctx.reload();
                ctx.render();
              },
            })
          : null,
      ),
    ),
    h('div', { class: 'md', html }),
  );
}

function highlight(html, q) {
  // highlight matches in text nodes only (never inside tags)
  const re = new RegExp(escapeRegExp(escapeHtml(q)), 'gi');
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => (part.startsWith('<') ? part : part.replace(re, (m) => `<mark>${m}</mark>`)))
    .join('');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderRelated(ctx, conv) {
  const { state } = ctx;
  const related = relatedConversations(conv, state.index, 5);
  if (!related.length) return null;
  return h(
    'div',
    { class: 'panel stack' },
    h('div', { class: 'section-label' }, 'Related conversations'),
    ...related.map(({ conversation: c, sharedTerms }) =>
      h(
        'button',
        { class: 'btn ghost block', style: { justifyContent: 'flex-start', textAlign: 'left', padding: '6px 8px' }, onClick: () => ctx.openReader(c.id) },
        h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'truncate' }, c.title), h('div', { class: 'tiny muted truncate' }, `${platformLabel(c.platform)} · ${sharedTerms.join(', ')}`)),
        icon('chevronRight', 14),
      ),
    ),
  );
}
