// Capture view: the conversation on the active chat tab.

import { h, button, select, empty, toast, copyText } from '../dom.js';
import { icon } from '../icons.js';
import * as store from '../../lib/storage.js';
import { exportConversation, toMarkdown } from '../../lib/exporters.js';
import { PLATFORMS, platformLabel, wordCount, estimateTokens, plural, truncate } from '../../lib/util.js';
import { exportOne, notifyExport, sendMessage } from '../actions.js';

const FORMAT_OPTIONS = [
  ['markdown', 'Markdown (.md)'],
  ['plain', 'Plain text (.txt)'],
  ['json', 'JSON (.json)'],
  ['html', 'HTML (.html)'],
  ['pdf', 'PDF (print)'],
];

export function renderCapture(ctx) {
  const { state } = ctx;
  if (state.currentLoading && !state.current) {
    return h('div', { class: 'empty' }, h('div', { class: 'row', style: { justifyContent: 'center' } }, h('span', { class: 'spinner' }), h('span', { class: 'muted' }, 'Reading the current chat…')));
  }
  if (!state.current) return renderNoConversation(ctx);
  return renderConversation(ctx);
}

function renderNoConversation(ctx) {
  const { state } = ctx;
  const quickLinks = h(
    'div',
    { class: 'chips', style: { justifyContent: 'center' } },
    Object.entries(PLATFORMS)
      .filter(([, p]) => p.newChat)
      .map(([id, p]) => h('button', { class: 'chip clickable', onClick: () => chrome.tabs.create({ url: p.newChat }) }, h('span', { class: 'platform-dot', style: { background: p.color } }), p.label)),
  );
  return h(
    'div',
    { class: 'stack fade' },
    empty({
      iconName: 'message',
      title: state.currentErrorCode === 'unsupported' ? 'Open a chat to get started' : 'No conversation found',
      text: state.currentError ?? 'Open a ChatGPT, Claude, Gemini or Perplexity conversation in this window.',
      action: button({ label: 'Refresh', iconName: 'refresh', className: 'btn', onClick: () => ctx.loadCurrent() }),
    }),
    quickLinks,
    state.index.length
      ? h('p', { class: 'small muted', style: { textAlign: 'center', margin: 0 } }, `You have ${plural(state.index.length, 'saved conversation')} in your `, h('a', { href: '#', onClick: (e) => (e.preventDefault(), ctx.goto('library')) }, 'Library'), '.')
      : null,
  );
}

function renderConversation(ctx) {
  const { state } = ctx;
  const { conv, savedMeta } = state.current;
  const platform = PLATFORMS[conv.platform] ?? PLATFORMS.other;
  const selected = new Set([...state.selectedMessages].filter((id) => conv.messages.some((m) => m.id === id)));
  const selectedMsgs = conv.messages.filter((m) => selected.has(m.id));
  const text = selectedMsgs.map((m) => m.content).join('\n');
  const template = state.templates.find((t) => t.id === state.promptId);
  const exportOpts = {
    selectedIds: selected.size === conv.messages.length ? undefined : selected,
    frontmatter: state.settings.frontmatter,
    includeTimestamps: state.settings.includeTimestamps,
    includeSystemMessages: state.settings.includeSystemMessages,
    appendPrompt: template?.body,
  };

  const header = h(
    'div',
    { class: 'row between', style: { alignItems: 'flex-start' } },
    h(
      'div',
      { class: 'grow' },
      h('h2', { class: 'title clamp-2', title: conv.title }, conv.title),
      h(
        'div',
        { class: 'row small muted', style: { marginTop: '3px', gap: '6px' } },
        h('span', { class: 'platform-dot', style: { background: platform.color } }),
        platformLabel(conv.platform),
        h('span', { class: 'faint' }, '·'),
        conv.captureLevel === 'full' ? h('span', { class: 'badge ok' }, 'Full thread') : h('span', { class: 'badge neutral' }, 'Visible messages'),
        savedMeta ? h('span', { class: 'badge ok', title: 'This conversation is in your library' }, icon('check', 10), ' Saved') : null,
      ),
    ),
    button({ iconName: 'refresh', className: `btn icon ${state.currentLoading ? 'active' : ''}`, title: 'Re-read the page', onClick: () => ctx.loadCurrent() }),
  );

  const stats = h(
    'div',
    { class: 'stats' },
    stat(`${selectedMsgs.length}${selected.size !== conv.messages.length ? `/${conv.messages.length}` : ''}`, 'messages'),
    stat(wordCount(text).toLocaleString(), 'words'),
    stat(`~${estimateTokens(text).toLocaleString()}`, 'tokens'),
  );

  const formatSelect = select({
    value: state.format,
    options: FORMAT_OPTIONS,
    ariaLabel: 'Export format',
    onChange: (v) => {
      state.format = v;
      ctx.render();
    },
  });
  const promptSelect = select({
    value: state.promptId,
    options: [['', 'No prompt appended'], ...state.templates.map((t) => [t.id, `+ ${t.title}`])],
    ariaLabel: 'Append prompt',
    onChange: (v) => {
      state.promptId = v;
      ctx.render();
    },
  });

  const doCopy = async () => {
    const format = state.format === 'pdf' ? 'markdown' : state.format;
    await copyText(exportConversation(conv, format, exportOpts));
    toast(`Copied ${plural(selectedMsgs.length, 'message')} as ${format === 'markdown' ? 'Markdown' : format.toUpperCase()}`);
  };
  const doExport = async () => notifyExport(await exportOne(conv, state.format, exportOpts, state.settings));
  const doSave = async () => {
    const meta = await store.saveConversation({ ...conv, id: savedMeta?.id ?? conv.id });
    conv.id = meta.id;
    state.current.savedMeta = meta;
    await ctx.reload();
    ctx.render();
    toast(savedMeta ? 'Library copy updated' : 'Saved to your library', { action: { label: 'Open', onClick: () => ctx.openReader(meta.id) } });
  };

  const actions = h(
    'div',
    { class: 'grid-3' },
    button({ label: 'Copy', iconName: 'copy', onClick: doCopy }),
    button({ label: state.format === 'pdf' ? 'Print' : 'Download', iconName: state.format === 'pdf' ? 'printer' : 'download', onClick: doExport }),
    button({ label: savedMeta ? 'Update' : 'Save', iconName: 'save', className: `btn ${savedMeta ? '' : 'primary'}`, onClick: doSave }),
  );

  const transfer = renderTransfer(ctx, () => {
    const body = template?.body ?? 'Continue this conversation from here. Preserve the useful context and take the next best step.';
    return `${toMarkdown(conv, { ...exportOpts, appendPrompt: undefined })}\n\n---\n\n${body}`;
  });

  const secondary = h(
    'div',
    { class: 'grid-2' },
    button({
      label: state.deepScanning ? 'Scanning…' : 'Full thread',
      iconName: 'scan',
      disabled: state.deepScanning,
      title: 'Scrolls the chat to collect every message, including ones that are not rendered yet',
      onClick: () => runDeepScan(ctx),
    }),
    // The page capture is shown as-is; it is not the library copy, so the reader must not edit
    // tags/notes/messages through it (it offers "Open saved copy" for that).
    button({ label: 'Read', iconName: 'eye', title: 'Open in the reader', onClick: () => ctx.openReader(conv.id ?? 'current', { conv: { ...conv, messages: conv.messages }, transient: true }) }),
  );

  return h(
    'div',
    { class: 'stack fade', style: { gap: '12px' } },
    header,
    stats,
    h('div', { class: 'grid-2' }, formatSelect, promptSelect),
    actions,
    transfer,
    secondary,
    renderMessages(ctx, conv, selected),
  );
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'value' }, value), h('div', { class: 'label' }, label));
}

export function renderTransfer(ctx, getText, { label = 'Transfer' } = {}) {
  const { state } = ctx;
  const targets = Object.entries(PLATFORMS).filter(([, p]) => p.newChat);
  const sel = select({
    value: state.transfer.target,
    options: targets.map(([id, p]) => [id, `→ ${p.label}`]),
    className: 'select',
    ariaLabel: 'Transfer destination',
    onChange: (v) => {
      state.transfer.target = v;
    },
  });
  const auto = state.settings.autoSendOnTransfer;
  const btn = button({
    label: state.transfer.busy ? 'Opening…' : `${label}${auto ? ' & send' : ''}`,
    iconName: 'send',
    className: 'btn',
    disabled: state.transfer.busy,
    title: auto ? 'Opens a new chat, pastes the context and sends it' : 'Opens a new chat and pastes the context (you press send)',
    onClick: async () => {
      const text = await getText();
      if (!text?.trim()) {
        toast('There is nothing to transfer yet', { type: 'error' });
        return;
      }
      state.transfer.busy = true;
      ctx.render();
      const res = await sendMessage({ type: 'TRANSFER_TO_LLM', destination: state.transfer.target, text, autoSend: auto });
      state.transfer.busy = false;
      ctx.render();
      if (res.ok) toast(res.data.sent ? `Sent to ${platformLabel(state.transfer.target)}` : `Pasted into ${platformLabel(state.transfer.target)} — press Send when ready`);
      else toast(res.error, { type: 'error', duration: 6000 });
    },
  });
  return h('div', { class: 'row' }, h('div', { style: { width: '42%' } }, sel), h('div', { class: 'grow' }, btn));
}

async function runDeepScan(ctx) {
  const { state } = ctx;
  state.deepScanning = true;
  ctx.setStatus('Scanning the full thread…');
  ctx.render();
  const res = await sendMessage({ type: 'DEEP_SCAN_CONVERSATION' });
  state.deepScanning = false;
  if (res.ok) {
    const conv = res.data;
    const saved = await store.findByUrl(conv.url);
    if (saved) conv.id = saved.id;
    state.current = { conv, savedMeta: saved, knownIds: new Set(conv.messages.map((m) => m.id)) };
    state.selectedMessages = new Set(conv.messages.map((m) => m.id));
    if (conv.captureLevel === 'full') {
      ctx.setStatus(`${conv.messages.length} messages (full thread)`);
      toast(`Full thread captured: ${plural(conv.messages.length, 'message')}`);
    } else {
      // the scan could not confirm the whole thread — say so rather than pretend
      ctx.setStatus(`${conv.messages.length} messages on this page`);
      toast('Scrolling did not reveal more than the visible messages, so this is still a visible-only capture.', { type: 'error', duration: 6000 });
    }
  } else {
    toast(res.error, { type: 'error' });
  }
  ctx.render();
}

function renderMessages(ctx, conv, selected) {
  const { state } = ctx;
  const setSel = (ids) => {
    state.selectedMessages = new Set(ids);
    ctx.render();
  };
  const toolbar = h(
    'div',
    { class: 'row between wrap' },
    h('span', { class: 'section-label' }, `Messages · ${selected.size}/${conv.messages.length} selected`),
    h(
      'div',
      { class: 'row', style: { gap: '2px' } },
      h('button', { class: 'text-btn muted', onClick: () => setSel(conv.messages.map((m) => m.id)) }, 'All'),
      h('button', { class: 'text-btn muted', onClick: () => setSel([]) }, 'None'),
      h('button', { class: 'text-btn muted', onClick: () => setSel(conv.messages.filter((m) => m.role === 'user').map((m) => m.id)) }, 'User'),
      h('button', { class: 'text-btn muted', onClick: () => setSel(conv.messages.filter((m) => m.role === 'assistant').map((m) => m.id)) }, 'AI'),
      h('button', { class: 'text-btn muted', title: 'Last 6 messages', onClick: () => setSel(conv.messages.slice(-6).map((m) => m.id)) }, 'Last 6'),
    ),
  );
  const rows = conv.messages.map((m) => {
    const expanded = state.expandedMessages.has(m.id);
    const body = h('div', { class: `body ${expanded ? 'expanded' : 'clamp-3'}` }, expanded ? m.content : truncate(m.content, 400));
    return h(
      'div',
      { class: `msg-row ${m.role} ${selected.has(m.id) ? '' : 'excluded'}` },
      h('input', {
        type: 'checkbox',
        checked: selected.has(m.id),
        'aria-label': `Include ${m.role} message`,
        onChange: (e) => {
          if (e.target.checked) state.selectedMessages.add(m.id);
          else state.selectedMessages.delete(m.id);
          ctx.render();
        },
      }),
      h('div', { class: 'grow' }, h('div', { class: 'role' }, m.role === 'user' ? 'You' : m.role === 'system' ? 'System' : platformLabel(conv.platform)), body),
      h(
        'div',
        { class: 'actions' },
        button({
          iconName: expanded ? 'chevronDown' : 'chevronRight',
          className: 'btn icon sm',
          title: expanded ? 'Collapse' : 'Expand',
          onClick: () => {
            if (expanded) state.expandedMessages.delete(m.id);
            else state.expandedMessages.add(m.id);
            ctx.render();
          },
        }),
        button({
          iconName: 'copy',
          className: 'btn icon sm',
          title: 'Copy this message',
          onClick: async () => {
            await copyText(m.content);
            toast('Message copied');
          },
        }),
      ),
    );
  });
  return h('div', { class: 'stack' }, toolbar, ...rows);
}
