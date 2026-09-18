// Shared side-panel actions: downloads, clipboard, printing, transfers.

import { exportConversation, extensionFor, mimeFor, filenameFor, toCombinedMarkdown, toLibraryJson, toMarkdown, toJson } from '../lib/exporters.js';
import { createZip } from '../lib/zip.js';
import { safeFilename, uid } from '../lib/util.js';
import { toast } from './dom.js';

export async function downloadBlob(filename, blob, settings = {}) {
  const url = URL.createObjectURL(blob);
  const folder = (settings.downloadSubfolder ?? '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
  const path = folder ? `${safeFilename(folder)}/${filename}` : filename;
  try {
    await chrome.downloads.download({ url, filename: path, saveAs: Boolean(settings.askWhereToSave), conflictAction: 'uniquify' });
  } catch {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

export function downloadText(filename, text, mime = 'text/plain', settings = {}) {
  return downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }), settings);
}

export async function openPrintPage(conv, opts = {}) {
  const token = uid('print');
  const payload = { conv, opts, createdAt: Date.now() };
  const key = `cb.print.${token}`;
  // chrome.storage.session has a 10 MB quota; very long conversations fall back to local storage
  // (print.js removes the key once it has read it).
  try {
    await chrome.storage.session.set({ [key]: payload });
  } catch {
    await chrome.storage.local.set({ [key]: payload });
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?token=${token}`) });
}

/**
 * Export one conversation in the given format, honouring user settings.
 * Never throws: returns { kind: 'download' | 'print' | 'error', ... } for notifyExport().
 */
export async function exportOne(conv, format, opts, settings) {
  try {
    if (format === 'pdf') {
      await openPrintPage(conv, opts);
      return { kind: 'print' };
    }
    const content = exportConversation(conv, format, opts);
    const filename = filenameFor(conv, settings.filenameTemplate, extensionFor(format));
    await downloadText(filename, content, mimeFor(format), settings);
    return { kind: 'download', filename };
  } catch (err) {
    return { kind: 'error', error: err?.message ?? 'Export failed.' };
  }
}

/** Standard toast for an exportOne() result. */
export function notifyExport(res) {
  if (res.kind === 'download') toast(`Downloaded ${res.filename}`);
  else if (res.kind === 'print') toast('Opened print view — choose "Save as PDF"');
  else toast(res.error ?? 'Export failed.', { type: 'error', duration: 6000 });
  return res;
}

/** Export many conversations as a single Markdown/JSON file or a ZIP archive. */
export async function exportMany(convs, format, opts, settings) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'zip') {
    const files = [
      { name: 'library.json', data: toLibraryJson(convs) },
      { name: 'library.md', data: toCombinedMarkdown(convs, opts) },
    ];
    convs.forEach((c, i) => {
      const base = `${String(i + 1).padStart(3, '0')} ${safeFilename(c.title)}`;
      files.push({ name: `markdown/${base}.md`, data: toMarkdown(c, opts) });
      files.push({ name: `json/${base}.json`, data: toJson(c, opts) });
    });
    await downloadBlob(`conversation-bridge-${stamp}.zip`, new Blob([createZip(files)], { type: 'application/zip' }), settings);
    return;
  }
  if (format === 'json') {
    await downloadText(`conversation-bridge-${stamp}.json`, toLibraryJson(convs), 'application/json', settings);
    return;
  }
  await downloadText(`conversation-bridge-${stamp}.md`, toCombinedMarkdown(convs, opts), 'text/markdown', settings);
}

export function sendMessage(message) {
  return chrome.runtime.sendMessage(message).catch((err) => ({ ok: false, error: err?.message ?? 'The extension is not responding. Try reopening the panel.' }));
}
