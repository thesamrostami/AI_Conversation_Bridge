// Welcome page: apply the theme and wire the "open side panel" button.

import { getSettings } from '../lib/storage.js';

const settings = await getSettings();
const pref = settings.theme ?? 'system';
const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.dataset.theme = dark ? 'dark' : 'light';

document.getElementById('open-panel')?.addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch {
    alert('Click the Conversation Bridge icon in the toolbar to open the panel.');
  }
});
