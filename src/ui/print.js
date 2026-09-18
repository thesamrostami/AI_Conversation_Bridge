// Print page: renders a conversation with the HTML export template and opens the print dialog
// (the user chooses "Save as PDF"). The conversation is handed over via chrome.storage.session.

import { toHtml } from '../lib/exporters.js';

async function main() {
  const token = new URLSearchParams(location.search).get('token');
  const key = `cb.print.${token}`;
  // The panel prefers chrome.storage.session and falls back to local for very large chats.
  let store = chrome.storage.session;
  let payload = (await store.get(key).catch(() => ({})))[key];
  if (!payload) {
    store = chrome.storage.local;
    payload = (await store.get(key))[key];
  }
  if (!payload?.conv) {
    document.getElementById('print-root').innerHTML = '<p style="font-family: system-ui; padding: 24px">Nothing to print. Close this tab and try again from the panel.</p>';
    return;
  }
  await store.remove(key);
  const html = toHtml(payload.conv, payload.opts ?? {});
  // Replace the whole document with the export so the print output matches the HTML export exactly.
  document.open();
  document.write(html);
  document.close();
  document.title = payload.conv.title;
  setTimeout(() => window.print(), 300);
}

main().catch((err) => {
  document.getElementById('print-root').textContent = `Could not prepare the print view: ${err?.message ?? err}`;
});
