// Conversation Bridge — background service worker (ES module).

import { migrate, saveConversation, findByUrl, getSettings, getConversation } from './lib/storage.js';
import { toMarkdown, exportConversation, extensionFor, mimeFor, filenameFor } from './lib/exporters.js';
import { PLATFORMS, sleep, safeFilename } from './lib/util.js';

const MENU = { save: 'cb-save', copy: 'cb-copy', open: 'cb-open' };
const SUPPORTED_HOST = /(^|\.)((chatgpt|openai)\.com|claude\.ai|perplexity\.ai|gemini\.google\.com)$/;
const TRANSFER_LIMIT = 200000; // characters

let lastChatTabId;

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.save, title: 'Save conversation to Conversation Bridge', contexts: ['page'], documentUrlPatterns: hostPatterns() });
    chrome.contextMenus.create({ id: MENU.copy, title: 'Copy conversation as Markdown', contexts: ['page'], documentUrlPatterns: hostPatterns() });
    chrome.contextMenus.create({ id: MENU.open, title: 'Open Conversation Bridge', contexts: ['action'] });
  });
  await migrate().catch(() => {});
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

function hostPatterns() {
  return chrome.runtime.getManifest().content_scripts[0].matches;
}

// ---------- context menu + commands ----------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU.open) {
    if (tab?.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    return;
  }
  if (tab?.id === undefined) return;
  lastChatTabId = tab.id;
  if (info.menuItemId === MENU.save) notifyResult(tab.id, await saveFromTab(tab.id));
  if (info.menuItemId === MENU.copy) notifyResult(tab.id, await copyFromTab(tab.id));
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (tab?.id === undefined) return;
  if (command === 'copy-current-conversation') notifyResult(tab.id, await copyFromTab(tab.id));
  if (command === 'save-current-conversation') notifyResult(tab.id, await saveFromTab(tab.id));
  if (command === 'export-current-conversation') notifyResult(tab.id, await exportFromTab(tab.id));
});

// ---------- tab tracking (badge + panel refresh) ----------

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((tab) => {
    if (isSupported(tab)) lastChatTabId = tabId;
    broadcast({ type: 'ACTIVE_TAB_CHANGED', tabId });
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && isSupported(tab)) {
    lastChatTabId = tabId;
    broadcast({ type: 'ACTIVE_TAB_CHANGED', tabId });
  }
});

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ---------- messages ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (promise) => {
    promise.then(sendResponse).catch((err) => sendResponse({ ok: false, error: err?.message ?? 'Unexpected error' }));
    return true;
  };
  switch (message?.type) {
    case 'CONTENT_SCRIPT_READY': {
      if (sender.tab?.id !== undefined) lastChatTabId = sender.tab.id;
      return respond(getSettings().then((s) => ({ ok: true, data: { liveSync: s.liveSync } })));
    }
    case 'PAGE_NAVIGATED':
      broadcast({ type: 'ACTIVE_TAB_CHANGED', tabId: sender.tab?.id });
      sendResponse({ ok: true });
      return false;
    case 'PAGE_CONTENT_CHANGED':
      if (sender.tab?.id !== undefined) liveSync(sender.tab.id, message.url).catch(() => {});
      sendResponse({ ok: true });
      return false;
    case 'GET_CURRENT_CONVERSATION':
      return respond(extractFromCurrent('quick', message.tabId));
    case 'DEEP_SCAN_CONVERSATION':
      return respond(extractFromCurrent('deep', message.tabId));
    case 'GET_ACTIVE_TAB':
      return respond(activeTab().then((tab) => ({ ok: true, data: tab ? { id: tab.id, url: tab.url, supported: isSupported(tab) } : null })));
    case 'SAVE_CURRENT_CONVERSATION':
      return respond(activeTab().then((tab) => (tab?.id === undefined ? { ok: false, error: 'No active tab.' } : saveFromTab(tab.id))));
    case 'COPY_CURRENT_CONVERSATION':
      return respond(activeTab().then((tab) => (tab?.id === undefined ? { ok: false, error: 'No active tab.' } : copyFromTab(tab.id))));
    case 'TRANSFER_TO_LLM':
      return respond(transfer(message.destination, message.text, message.autoSend !== false));
    case 'INSERT_INTO_ACTIVE_TAB':
      return respond(insertIntoActive(message.text, message.autoSend === true));
    case 'LIVE_SYNC_CHANGED':
      return respond(pushLiveSyncState());
    default:
      return false;
  }
});

// ---------- helpers ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && isSupported(tab)) return tab;
  if (lastChatTabId !== undefined) {
    const remembered = await chrome.tabs.get(lastChatTabId).catch(() => null);
    if (remembered && isSupported(remembered)) return remembered;
  }
  return tab;
}

function isSupported(tab) {
  if (!tab?.url) return false;
  try {
    return SUPPORTED_HOST.test(new URL(tab.url).hostname);
  } catch {
    return false;
  }
}

async function extractFromCurrent(mode, tabId) {
  const tab = tabId !== undefined ? await chrome.tabs.get(tabId).catch(() => null) : await activeTab();
  if (!tab || tab.id === undefined) return { ok: false, error: 'No active tab was found.' };
  if (!isSupported(tab)) {
    return { ok: false, error: 'Open a ChatGPT, Claude, Gemini or Perplexity conversation in this window, then click Refresh.', code: 'unsupported' };
  }
  lastChatTabId = tab.id;
  return extractFromTab(tab.id, mode);
}

async function extractFromTab(tabId, mode = 'quick') {
  const send = () => chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_CONVERSATION', mode });
  try {
    return await send();
  } catch {
    // content script not injected yet (extension was just installed/updated) — inject and retry
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
      await sleep(150);
      return await send();
    } catch {
      return { ok: false, error: 'Chrome could not connect to this tab yet. Reload the chat page once, then click Refresh.', code: 'reload' };
    }
  }
}

async function saveFromTab(tabId) {
  const res = await extractFromTab(tabId);
  if (!res.ok) return res;
  const meta = await saveConversation(res.data);
  broadcast({ type: 'LIBRARY_CHANGED' });
  return { ok: true, data: meta };
}

async function copyFromTab(tabId) {
  const res = await extractFromTab(tabId);
  if (!res.ok) return res;
  const settings = await getSettings();
  const text = toMarkdown(res.data, { frontmatter: settings.frontmatter, includeTimestamps: settings.includeTimestamps });
  try {
    // navigator.clipboard needs a focused document (not the case when the shortcut fires while the
    // panel has focus), so fall back to execCommand('copy') and report what actually happened.
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (t) => {
        try {
          await navigator.clipboard.writeText(t);
          return true;
        } catch {
          /* fall back below */
        }
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('data-cb-skip', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
        document.documentElement.appendChild(ta);
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch {
          ok = false;
        }
        ta.remove();
        return ok;
      },
      args: [text],
    });
    if (result !== true) return { ok: false, error: 'Clipboard access was blocked. Click inside the chat page and try again.' };
    return { ok: true, data: { chars: text.length } };
  } catch {
    return { ok: false, error: 'Clipboard access was blocked. Click inside the chat page and try again.' };
  }
}

/** Keyboard command: download the current chat in the user's default format (PDF → HTML). */
async function exportFromTab(tabId) {
  const res = await extractFromTab(tabId);
  if (!res.ok) return res;
  const settings = await getSettings();
  const format = settings.defaultFormat === 'pdf' ? 'html' : settings.defaultFormat || 'markdown';
  const opts = { frontmatter: settings.frontmatter, includeTimestamps: settings.includeTimestamps, includeSystemMessages: settings.includeSystemMessages };
  const content = exportConversation(res.data, format, opts);
  const filename = filenameFor(res.data, settings.filenameTemplate, extensionFor(format));
  const folder = (settings.downloadSubfolder ?? '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
  const path = folder ? `${safeFilename(folder)}/${filename}` : filename;
  // Service workers have no URL.createObjectURL; a data: URL is accepted by the downloads API.
  const url = `data:${mimeFor(format)};charset=utf-8,${encodeURIComponent(content)}`;
  try {
    await chrome.downloads.download({ url, filename: path, saveAs: Boolean(settings.askWhereToSave), conflictAction: 'uniquify' });
    return { ok: true, data: { filename } };
  } catch (err) {
    return { ok: false, error: `Download failed: ${err?.message ?? 'unknown error'}` };
  }
}

function notifyResult(tabId, res) {
  const text = res.ok ? `Conversation Bridge: ${res.data?.filename ? `downloaded ${res.data.filename}` : 'done'} ✓` : `Conversation Bridge: ${res.error}`;
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (msg, ok) => {
        const el = document.createElement('div');
        el.setAttribute('data-cb-skip', '');
        el.textContent = msg;
        el.style.cssText = `position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;border-radius:10px;background:${ok ? '#065f46' : '#7f1d1d'};color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3);transition:opacity .3s`;
        document.documentElement.appendChild(el);
        setTimeout(() => {
          el.style.opacity = '0';
          setTimeout(() => el.remove(), 350);
        }, 2600);
      },
      args: [text, res.ok],
    })
    .catch(() => {});
}

// ---------- transfer to another assistant ----------

async function transfer(destination, text, autoSend) {
  const target = PLATFORMS[destination];
  if (!target?.newChat) return { ok: false, error: 'Choose ChatGPT, Claude, Gemini or Perplexity as the destination.' };
  if (!text?.trim()) return { ok: false, error: 'There is no conversation text to transfer.' };
  if (text.length > TRANSFER_LIMIT) {
    return { ok: false, error: `This transfer is ${Math.round(text.length / 1000)}k characters — too large for a reliable hand-off. Use a Working or Overview context packet, or select fewer messages.` };
  }
  const tab = await chrome.tabs.create({ url: target.newChat, active: true });
  if (tab.id === undefined) return { ok: false, error: 'Chrome could not open the destination chat.' };
  return waitAndInsert(tab.id, text, autoSend);
}

async function waitAndInsert(tabId, text, autoSend) {
  let lastError = 'The destination chat is still loading.';
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'INSERT_TRANSFER_CONTEXT', text, autoSend });
      if (res?.ok) return { ok: true, data: { tabId, sent: res.data.sent } };
      if (res?.error) lastError = res.error;
    } catch {
      /* content script not ready yet */
    }
    await sleep(400);
  }
  return { ok: false, error: `${lastError} The tab is open, so you can paste the text there manually.` };
}

async function insertIntoActive(text, autoSend) {
  const tab = await activeTab();
  if (!tab || tab.id === undefined || !isSupported(tab)) return { ok: false, error: 'Open a supported chat tab first.' };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'INSERT_TRANSFER_CONTEXT', text, autoSend });
    return res?.ok ? { ok: true, data: res.data } : res;
  } catch {
    return { ok: false, error: 'Chrome could not connect to this tab yet. Reload the chat page once and try again.' };
  }
}

// ---------- live sync ----------

const syncing = new Set();

async function liveSync(tabId, url) {
  if (syncing.has(tabId)) return;
  const settings = await getSettings();
  if (!settings.liveSync) return;
  const meta = await findByUrl(url);
  if (!meta || meta.liveSync === false) return;
  syncing.add(tabId);
  try {
    const res = await extractFromTab(tabId, 'quick');
    if (!res.ok) return;
    const existing = await getConversation(meta.id);
    const changed = existing.messages.length !== res.data.messages.length || existing.messages.at(-1)?.content !== res.data.messages.at(-1)?.content;
    if (!changed) return;
    // never shrink a full capture with a partial view
    if (existing.captureLevel === 'full' && res.data.messages.length < existing.messages.length) return;
    await saveConversation({ ...res.data, id: meta.id });
    broadcast({ type: 'LIBRARY_CHANGED', id: meta.id });
  } finally {
    syncing.delete(tabId);
  }
}

async function pushLiveSyncState() {
  const settings = await getSettings();
  const enabled = settings.liveSync;
  const tabs = await chrome.tabs.query({ url: hostPatterns() });
  await Promise.all(tabs.map((t) => (t.id !== undefined ? chrome.tabs.sendMessage(t.id, { type: 'SET_LIVE_SYNC', enabled }).catch(() => {}) : null)));
  return { ok: true };
}
