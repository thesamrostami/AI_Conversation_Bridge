// Conversation Bridge — side panel application shell.

import { h, button, toast, preserveFocus } from './dom.js';
import { icon } from './icons.js';
import * as store from '../lib/storage.js';
import { debounce } from '../lib/util.js';
import { sendMessage } from './actions.js';
import { renderCapture } from './views/capture.js';
import { renderLibrary } from './views/library.js';
import { renderReader } from './views/reader.js';
import { renderWorkflows } from './views/workflows.js';
import { renderPrompts } from './views/prompts.js';
import { renderSettings } from './views/settings.js';

const params = new URLSearchParams(location.search);
const STANDALONE = params.get('standalone') === '1';

export const state = {
  view: params.get('view') || 'capture',
  previousView: 'capture',
  standalone: STANDALONE,
  settings: { ...store.DEFAULT_SETTINGS },
  index: [],
  templates: [],
  workspaces: [],
  trashCount: 0,
  // capture view
  current: null, // { conv, tabId, savedMeta }
  currentLoading: false,
  currentError: null,
  deepScanning: false,
  selectedMessages: new Set(),
  format: 'markdown',
  promptId: '',
  expandedMessages: new Set(),
  // library view
  library: { query: '', platform: '', stage: '', favorite: false, sort: 'updated', selected: new Set(), limit: 40, tag: '' },
  // reader view
  reader: { id: null, conv: null, query: '', loading: false, transient: false },
  // workflows view
  workflow: { workspaceId: '', stage: 'all', selected: new Set(), focusId: '', level: 'working', promptId: '' },
  transfer: { target: 'claude', busy: false },
  status: 'Ready',
};

const root = document.getElementById('app');
let viewEl;
let statusEl;
let tabsEl;

export const ctx = {
  state,
  render,
  reload,
  loadCurrent,
  goto,
  openReader,
  setStatus,
  applyTheme: () => applyTheme(),
  reloadSettings: () => reloadSettings(),
};

// ---------- boot ----------

async function init() {
  if (STANDALONE) document.body.classList.add('standalone');
  await reloadSettings({ initial: true });
  applyTheme();
  buildShell();
  await reload();
  render();
  if (state.view === 'capture' || !STANDALONE) loadCurrent();
  wireGlobalListeners();
}

async function reloadSettings({ initial = false } = {}) {
  state.settings = await store.getSettings();
  if (initial) {
    state.format = state.settings.defaultFormat || 'markdown';
    state.transfer.target = state.settings.defaultTransferTarget || 'claude';
  }
}

export async function reload() {
  const [index, templates, workspaces, trash] = await Promise.all([store.listConversations(), store.listTemplates(), store.listWorkspaces(), store.listTrash()]);
  state.index = index;
  state.templates = templates;
  state.workspaces = workspaces;
  state.trashCount = trash.length;
  if (state.current?.conv) state.current.savedMeta = index.find((m) => m.id === state.current.conv.id) ?? (await store.findByUrl(state.current.conv.url));
  // a transient reader shows the page capture, not the library copy — leave it alone
  if (state.reader.id && state.view === 'reader' && !state.reader.transient) {
    const fresh = await store.getConversation(state.reader.id);
    if (fresh) state.reader.conv = fresh;
  }
}

function applyTheme() {
  const pref = state.settings.theme ?? 'system';
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// ---------- shell ----------

const TABS = [
  ['capture', 'Capture', 'zap'],
  ['library', 'Library', 'archive'],
  ['workflows', 'Flows', 'layers'],
  ['prompts', 'Prompts', 'book'],
  ['settings', 'Settings', 'settings'],
];

function buildShell() {
  root.replaceChildren();
  statusEl = h('div', { class: 'status truncate' }, state.status);
  const brand = h('div', { class: 'brand' }, h('img', { src: 'icons/icon48.png', alt: '' }), h('div', { class: 'grow' }, h('h1', {}, 'Conversation Bridge'), statusEl));
  const themeBtn = button({
    iconName: 'moon',
    className: 'btn icon',
    title: 'Toggle theme',
    onClick: async () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      state.settings = await store.updateSettings({ theme: dark ? 'light' : 'dark' });
      applyTheme();
      render();
    },
  });
  tabsEl = h('nav', { class: 'tabs', role: 'tablist' });
  const top = h('header', { class: 'topbar' }, h('div', { class: 'topbar-row' }, brand, themeBtn), tabsEl);
  viewEl = h('main', { class: 'view', id: 'view' });
  root.append(top, viewEl);
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...TABS.map(([id, label, ic]) =>
      h(
        'button',
        { class: `tab ${state.view === id || (state.view === 'reader' && id === 'library') ? 'active' : ''}`, role: 'tab', 'aria-selected': state.view === id, onClick: () => goto(id) },
        icon(ic, 16),
        h('span', {}, label),
      ),
    ),
  );
}

export function render() {
  preserveFocus(() => {
    renderTabs();
    document.documentElement.dataset.theme = document.documentElement.dataset.theme || 'light';
    let content;
    switch (state.view) {
      case 'library':
        content = renderLibrary(ctx);
        break;
      case 'reader':
        content = renderReader(ctx);
        break;
      case 'workflows':
        content = renderWorkflows(ctx);
        break;
      case 'prompts':
        content = renderPrompts(ctx);
        break;
      case 'settings':
        content = renderSettings(ctx);
        break;
      default:
        content = renderCapture(ctx);
    }
    viewEl.replaceChildren(content);
    statusEl.textContent = state.status;
  });
}

export function goto(view) {
  if (state.view !== view) state.previousView = state.view;
  state.view = view;
  render();
  viewEl.scrollTo?.(0, 0);
  window.scrollTo(0, 0);
}

/**
 * Open the reader. With `conv` the given object is shown as-is; `transient` marks it as a page
 * capture that is not the library copy (tags/notes/messages must not be edited through it).
 */
export async function openReader(id, { conv, transient = false } = {}) {
  state.previousView = state.view === 'reader' ? state.previousView : state.view;
  state.reader = { id, conv: conv ?? null, query: '', loading: !conv, transient: Boolean(conv) && transient };
  state.view = 'reader';
  render();
  if (!conv) {
    state.reader.conv = await store.getConversation(id);
    state.reader.loading = false;
    render();
  }
  window.scrollTo(0, 0);
}

export function setStatus(text) {
  state.status = text;
  if (statusEl) statusEl.textContent = text;
}

// ---------- current tab capture ----------

let loadToken = 0;

export async function loadCurrent({ silent = false } = {}) {
  const token = ++loadToken;
  state.currentLoading = true;
  state.currentError = null;
  if (!silent) setStatus('Reading the current chat…');
  if (state.view === 'capture') render();
  const res = await sendMessage({ type: 'GET_CURRENT_CONVERSATION' });
  if (token !== loadToken) return;
  state.currentLoading = false;
  if (res?.ok) {
    const conv = res.data;
    const saved = await store.findByUrl(conv.url);
    if (saved) conv.id = saved.id;
    const sameConv = state.current?.conv?.url === conv.url;
    const prevKnown = state.current?.knownIds ?? new Set();
    state.current = { conv, savedMeta: saved };
    if (!sameConv) {
      state.selectedMessages = new Set(conv.messages.map((m) => m.id));
      state.expandedMessages = new Set();
    } else {
      // keep the user's selection for messages that still exist; select any new ones
      const known = new Set(conv.messages.map((m) => m.id));
      const next = new Set([...state.selectedMessages].filter((id) => known.has(id)));
      conv.messages.forEach((m) => {
        if (!prevKnown.has(m.id)) next.add(m.id);
      });
      state.selectedMessages = next;
    }
    state.current.knownIds = new Set(conv.messages.map((m) => m.id));
    setStatus(`${conv.messages.length} messages on this page`);
  } else {
    state.current = null;
    state.currentError = res?.error ?? 'Could not read this tab.';
    state.currentErrorCode = res?.code;
    setStatus('No chat detected');
  }
  if (state.view === 'capture') render();
}

// ---------- global listeners ----------

function wireGlobalListeners() {
  const refreshCurrent = debounce(() => loadCurrent({ silent: true }), 400);
  // Library changes arrive both as a broadcast from the worker and as a storage event; one
  // debounced reload serves both so the panel does not re-render twice per change.
  const refreshLibrary = debounce(() => reload().then(render), 60);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'ACTIVE_TAB_CHANGED') refreshCurrent();
    if (message?.type === 'LIBRARY_CHANGED') refreshLibrary();
  });
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes['cb.settings']) {
      await reloadSettings();
      applyTheme();
    }
    if (changes['cb.index']) refreshLibrary();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshCurrent();
  });
  document.addEventListener('keydown', (e) => {
    // dialogs and card menus own the keyboard while they are open (Escape closes them, not the reader)
    if (document.querySelector('.modal-backdrop, [role="menu"]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') || document.activeElement?.isContentEditable;
    if (e.key === 'Escape' && state.view === 'reader') {
      goto(state.previousView === 'reader' ? 'library' : state.previousView);
      return;
    }
    if (typing) return;
    if (e.key === '/') {
      e.preventDefault();
      if (state.view !== 'library') goto('library');
      document.getElementById('lib-search')?.focus();
    }
    if (e.key === '1') goto('capture');
    if (e.key === '2') goto('library');
    if (e.key === '3') goto('workflows');
    if (e.key === '4') goto('prompts');
    if (e.key === '5') goto('settings');
  });
}

init().catch((err) => {
  console.error(err);
  root.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'notice danger' }, icon('alert'), h('span', {}, `The panel failed to start: ${err?.message ?? err}`))));
});

export { toast };
