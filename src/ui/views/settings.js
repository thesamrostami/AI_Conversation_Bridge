// Settings view: appearance, export defaults, live sync, data & backups.

import { h, button, select, toggle, settingRow, toast, confirm, modal } from '../dom.js';
import * as store from '../../lib/storage.js';
import { PLATFORMS, formatBytes, plural, relativeTime } from '../../lib/util.js';
import { downloadText, sendMessage } from '../actions.js';
import { importFile, invalidateSearchCache } from './library.js';

export function renderSettings(ctx) {
  return h('div', { class: 'stack fade', style: { gap: '14px' } }, renderAppearance(ctx), renderExportSettings(ctx), renderCaptureSettings(ctx), renderData(ctx), renderShortcuts(), renderAbout());
}

function section(title, ...children) {
  return h('section', { class: 'card stack', style: { gap: '2px' } }, h('div', { class: 'section-label', style: { marginBottom: '4px' } }, title), ...children);
}

// ---------- appearance ----------

function renderAppearance(ctx) {
  const { state } = ctx;
  const set = async (patch) => {
    state.settings = await store.updateSettings(patch);
    ctx.applyTheme();
    ctx.render();
  };
  return section(
    'Appearance',
    settingRow({
      label: 'Theme',
      control: select({ value: state.settings.theme, className: 'select sm', ariaLabel: 'Theme', options: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], onChange: (v) => set({ theme: v }) }),
    }),
    settingRow({
      label: 'Confirm before deleting',
      hint: 'Deleted chats go to the trash either way.',
      control: toggle({ checked: state.settings.confirmDelete, ariaLabel: 'Confirm before deleting', onChange: (v) => set({ confirmDelete: v }) }),
    }),
  );
}

// ---------- export ----------

function renderExportSettings(ctx) {
  const { state } = ctx;
  const set = async (patch) => {
    state.settings = await store.updateSettings(patch);
    ctx.render();
  };
  const template = h('input', {
    class: 'input sm',
    value: state.settings.filenameTemplate,
    'aria-label': 'File name template',
    style: { width: '150px' },
    onChange: (e) => set({ filenameTemplate: e.target.value.trim() || '{date} {title}' }),
  });
  return section(
    'Export defaults',
    settingRow({
      label: 'Default format',
      control: select({ value: state.settings.defaultFormat, className: 'select sm', ariaLabel: 'Default format', options: [['markdown', 'Markdown'], ['plain', 'Plain text'], ['json', 'JSON'], ['html', 'HTML']], onChange: (v) => set({ defaultFormat: v }) }),
    }),
    settingRow({
      label: 'YAML frontmatter',
      hint: 'Obsidian / Logseq-ready metadata at the top of Markdown files.',
      control: toggle({ checked: state.settings.frontmatter, ariaLabel: 'Frontmatter', onChange: (v) => set({ frontmatter: v }) }),
    }),
    settingRow({
      label: 'File name template',
      hint: 'Variables: {date} {time} {title} {platform} {messages} {id}',
      control: template,
    }),
    settingRow({
      label: 'Download subfolder',
      hint: 'Inside your Downloads folder. Leave empty for none.',
      control: h('input', { class: 'input sm', value: state.settings.downloadSubfolder, 'aria-label': 'Download subfolder', style: { width: '150px' }, onChange: (e) => set({ downloadSubfolder: e.target.value.trim() }) }),
    }),
    settingRow({
      label: 'Ask where to save each file',
      control: toggle({ checked: state.settings.askWhereToSave, ariaLabel: 'Ask where to save', onChange: (v) => set({ askWhereToSave: v }) }),
    }),
    settingRow({
      label: 'Include timestamps',
      hint: 'When the source provides them (imports, live sync).',
      control: toggle({ checked: state.settings.includeTimestamps, ariaLabel: 'Include timestamps', onChange: (v) => set({ includeTimestamps: v }) }),
    }),
  );
}

// ---------- capture / transfer ----------

function renderCaptureSettings(ctx) {
  const { state } = ctx;
  const set = async (patch) => {
    state.settings = await store.updateSettings(patch);
    ctx.render();
  };
  return section(
    'Transfer & sync',
    settingRow({
      label: 'Default destination',
      control: select({
        value: state.settings.defaultTransferTarget,
        className: 'select sm',
        ariaLabel: 'Default destination',
        options: Object.entries(PLATFORMS).filter(([, p]) => p.newChat).map(([id, p]) => [id, p.label]),
        onChange: (v) => {
          state.transfer.target = v;
          set({ defaultTransferTarget: v });
        },
      }),
    }),
    settingRow({
      label: 'Send automatically after transfer',
      hint: 'Off: the text is pasted and you press Send yourself.',
      control: toggle({ checked: state.settings.autoSendOnTransfer, ariaLabel: 'Auto send', onChange: (v) => set({ autoSendOnTransfer: v }) }),
    }),
    settingRow({
      label: 'Live sync',
      hint: 'Keeps saved chats updated while their tab is open. Enable per chat in the reader.',
      control: toggle({
        checked: state.settings.liveSync,
        ariaLabel: 'Live sync',
        onChange: async (v) => {
          await set({ liveSync: v });
          sendMessage({ type: 'LIVE_SYNC_CHANGED' });
        },
      }),
    }),
  );
}

// ---------- data ----------

function renderData(ctx) {
  const { state } = ctx;
  const usage = h('span', { class: 'small muted' }, '…');
  store.storageUsage().then((b) => (usage.textContent = formatBytes(b)));
  const backup = button({
    label: 'Back up everything',
    iconName: 'download',
    className: 'btn sm',
    onClick: async () => {
      const data = await store.exportBackup();
      await downloadText(`conversation-bridge-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json', { ...state.settings, askWhereToSave: true });
      toast('Backup downloaded');
    },
  });
  const restore = button({ label: 'Import / restore', iconName: 'upload', className: 'btn sm', title: 'Backup, library export, or official ChatGPT / Claude export', onClick: () => importFile(ctx) });
  const trash = button({
    label: `Trash (${state.trashCount})`,
    iconName: 'undo',
    className: 'btn sm',
    disabled: !state.trashCount,
    onClick: () => showTrash(ctx),
  });
  const clear = button({
    label: 'Delete all data',
    iconName: 'trash',
    className: 'btn sm danger',
    onClick: async () => {
      const ok = await confirm({ title: 'Delete all local data?', text: 'Every saved conversation, workflow and prompt on this browser is removed. Consider a backup first.', confirmLabel: 'Delete everything', danger: true });
      if (!ok) return;
      await store.clearAllData();
      invalidateSearchCache();
      await ctx.reload();
      await ctx.reloadSettings();
      ctx.render();
      toast('All local data deleted');
    },
  });
  return section(
    'Your data',
    h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, `${plural(state.index.length, 'conversation')} · ${plural(state.workspaces.length, 'workflow')} · ${plural(state.templates.length, 'prompt')} · `, usage, ' used. Everything is stored locally in this browser profile — nothing is uploaded.'),
    h('div', { class: 'row wrap', style: { gap: '6px' } }, backup, restore, trash),
    h('div', { class: 'row', style: { marginTop: '8px' } }, clear),
  );
}

async function showTrash(ctx) {
  const items = await store.listTrash();
  const list = h(
    'div',
    { class: 'stack' },
    items.length
      ? items.map((t) =>
          h(
            'div',
            { class: 'row between', style: { gap: '8px' } },
            h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'truncate', style: { fontWeight: 550 } }, t.title), h('div', { class: 'tiny muted' }, `Deleted ${relativeTime(t.deletedAt)} · ${plural(t.messages?.length ?? 0, 'message')}`)),
            button({
              label: 'Restore',
              className: 'btn sm',
              onClick: async () => {
                await store.restoreFromTrash(t.id);
                await ctx.reload();
                close();
                ctx.render();
                toast('Restored');
              },
            }),
          ),
        )
      : h('p', { class: 'muted small', style: { margin: 0 } }, 'The trash is empty.'),
  );
  const { close } = modal({
    title: 'Trash',
    body: [h('p', { class: 'tiny muted', style: { margin: 0 } }, `The ${store.TRASH_LIMIT} most recently deleted conversations are kept here.`), list],
    actions: items.length ? [{ label: 'Empty trash', danger: true, onClick: async () => (await store.emptyTrash(), await ctx.reload(), ctx.render()) }] : [],
  });
}

// ---------- shortcuts / about ----------

const COMMAND_LABELS = {
  _execute_action: 'Open the panel',
  'copy-current-conversation': 'Copy current chat as Markdown',
  'save-current-conversation': 'Save current chat',
  'export-current-conversation': 'Download current chat',
};

const PANEL_KEYS = [
  ['Switch tabs inside the panel', '1 – 5'],
  ['Search the library', '/'],
  ['Close the reader', 'Esc'],
];

function renderShortcuts() {
  const row = (label, keys) => h('div', { class: 'setting', style: { padding: '6px 0' } }, h('span', { class: 'small' }, label), h('span', { class: 'kbd' }, keys));
  // Browser-level shortcuts are whatever Chrome has actually bound for this profile
  // (users can change them, and Chrome skips defaults that clash with its own keys).
  const suggested = chrome.runtime.getManifest().commands ?? {};
  const browserRows = h('div', {}, ...Object.entries(COMMAND_LABELS).map(([name, label]) => row(label, suggested[name]?.suggested_key?.default ?? 'Not set')));
  const bound = chrome.commands?.getAll?.();
  if (bound) {
    bound
      .then((cmds) => browserRows.replaceChildren(...cmds.filter((c) => COMMAND_LABELS[c.name]).map((c) => row(COMMAND_LABELS[c.name], c.shortcut || 'Not set'))))
      .catch(() => {});
  }
  return section(
    'Keyboard shortcuts',
    browserRows,
    ...PANEL_KEYS.map(([label, keys]) => row(label, keys)),
    h('div', { class: 'row', style: { marginTop: '8px' } }, button({ label: 'Change browser shortcuts', iconName: 'keyboard', className: 'btn sm ghost', onClick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) })),
  );
}

function renderAbout() {
  const m = chrome.runtime.getManifest();
  return section(
    'About',
    h('p', { class: 'small muted', style: { margin: 0 } }, `${m.name} ${m.version}. Captures ChatGPT, Claude, Gemini and Perplexity conversations locally. No accounts, no servers, no tracking.`),
    h('p', { class: 'tiny muted', style: { margin: '6px 0 0' } }, 'Open source under the MIT licence. Built by Sam Rostami, with help from Claude Code.'),
    h(
      'div',
      { class: 'row wrap', style: { gap: '6px', marginTop: '8px' } },
      button({ label: 'Welcome tour', iconName: 'sparkles', className: 'btn sm ghost', onClick: () => chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }) }),
      button({ label: 'Privacy', iconName: 'shield', className: 'btn sm ghost', onClick: () => chrome.tabs.create({ url: chrome.runtime.getURL('docs/privacy.html') }) }),
    ),
  );
}

