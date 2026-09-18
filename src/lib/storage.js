// Storage layer on top of chrome.storage.local.
//
// Layout (all keys prefixed with "cb."):
//   cb.index          -> ConversationMeta[]   (lightweight, loaded on every panel open)
//   cb.conv.<id>      -> { messages: Message[] }  (loaded on demand)
//   cb.templates      -> Template[]
//   cb.workspaces     -> Workspace[]
//   cb.settings       -> Settings
//   cb.meta           -> { schemaVersion, installedAt }
//
// v0.3.0 stored everything in "conversationBridge.*"; migrate() moves it over once.

import { uid, hash, nowIso, wordCount, truncate, safeHttpUrl } from './util.js';
import { autoTagsFor } from './similarity.js';

export const KEYS = {
  index: 'cb.index',
  conv: (id) => `cb.conv.${id}`,
  templates: 'cb.templates',
  workspaces: 'cb.workspaces',
  settings: 'cb.settings',
  meta: 'cb.meta',
  trash: 'cb.trash',
};

const SCHEMA_VERSION = 2;

export const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark
  defaultFormat: 'markdown',
  frontmatter: false,
  includeTimestamps: false,
  includeSystemMessages: false,
  filenameTemplate: '{date} {title}',
  downloadSubfolder: 'Conversation Bridge',
  askWhereToSave: false,
  liveSync: false,
  defaultTransferTarget: 'claude',
  autoSendOnTransfer: true,
  confirmDelete: true,
};

export const DEFAULT_TEMPLATES = [
  {
    id: 'template_continue',
    title: 'Continue from here',
    body: 'Continue from here. Preserve the useful context, then propose the next concrete steps.',
    builtIn: true,
  },
  {
    id: 'template_critique',
    title: 'Critique this discussion',
    body: 'Critique this discussion. Identify weak assumptions, unsupported claims, and better ways to frame the problem.',
    builtIn: true,
  },
  {
    id: 'template_summarize',
    title: 'Summarize decisions',
    body: 'Summarize this conversation as: 1) decisions made, 2) open questions, 3) next actions. Be concise and concrete.',
    builtIn: true,
  },
  {
    id: 'template_perspective',
    title: 'Another perspective',
    body: 'Provide another perspective. Challenge the main conclusion and explain what may have been missed.',
    builtIn: true,
  },
  {
    id: 'template_consensus',
    title: 'Check against consensus',
    body: 'Compare this discussion with the academic or professional consensus. Separate well-supported points from speculation.',
    builtIn: true,
  },
];

// ---------- low level ----------

async function get(key, fallback) {
  const res = await chrome.storage.local.get(key);
  return res[key] ?? fallback;
}

async function set(obj) {
  await chrome.storage.local.set(obj);
}

async function remove(keys) {
  await chrome.storage.local.remove(keys);
}

// Panel and service worker both read-modify-write cb.index; a Web Lock (shared per origin,
// so across both contexts) serialises them. Not available under Node → run unguarded.
function locked(fn) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request('cb.index', fn) : fn();
}

// ---------- normalisation ----------

export function normalizeMessage(m, i = 0) {
  return {
    id: m.id ?? uid('msg'),
    role: m.role === 'user' || m.role === 'system' ? m.role : 'assistant',
    content: String(m.content ?? '').trim(),
    timestamp: m.timestamp ?? undefined,
    index: i,
  };
}

/** Derive lightweight metadata from a full conversation. */
export function toMeta(conv) {
  const messages = conv.messages ?? [];
  const text = messages.map((m) => m.content).join('\n');
  const firstUser = messages.find((m) => m.role === 'user');
  const meta = {
    id: conv.id,
    title: conv.title || 'Untitled conversation',
    titleEdited: Boolean(conv.titleEdited),
    platform: conv.platform || 'other',
    url: safeHttpUrl(conv.url),
    createdAt: conv.createdAt || nowIso(),
    updatedAt: conv.updatedAt || nowIso(),
    savedAt: conv.savedAt || nowIso(),
    tags: Array.isArray(conv.tags) ? conv.tags : [],
    autoTags: Array.isArray(conv.autoTags) ? conv.autoTags : [],
    favorite: Boolean(conv.favorite),
    pinned: Boolean(conv.pinned),
    notes: conv.notes || '',
    workspaceId: conv.workspaceId || undefined,
    workflowStage: conv.workflowStage || 'inbox',
    priority: conv.priority || 'normal',
    retentionLevel: conv.retentionLevel || 'working',
    captureLevel: conv.captureLevel || 'quick',
    messageCount: messages.length,
    wordCount: wordCount(text),
    chars: text.length,
    preview: truncate(firstUser?.content ?? messages[0]?.content ?? '', 160),
    liveSync: Boolean(conv.liveSync),
  };
  meta.autoTags = autoTagsFor({ ...meta, messages });
  return meta;
}

/**
 * Stable conversation id derived from the chat URL (so re-saving updates in place).
 * Aliases of the same chat map to one id: chat.openai.com → chatgpt.com, and ChatGPT project
 * URLs (/g/g-p-…/c/<id>) → /c/<id>. Plain chatgpt.com/c/… ids are unchanged from earlier versions.
 */
export function idForUrl(url) {
  try {
    const u = new URL(url);
    let host = u.hostname;
    let path = u.pathname.replace(/\/+$/, '');
    if (host === 'chat.openai.com') host = 'chatgpt.com';
    if (host === 'chatgpt.com') {
      const m = /^\/g\/[^/]+(\/c\/[^/]+)$/.exec(path);
      if (m) path = m[1];
    }
    // Only trust URLs that point at a specific conversation, not the "new chat" landing page.
    if (!path || path === '/new' || path === '/app' || path === '/chat' || path === '/') return null;
    return `conv_${hash(`${host}${path}`)}`;
  } catch {
    return null;
  }
}

// ---------- conversations ----------

export async function listConversations() {
  const index = await get(KEYS.index, []);
  return index;
}

export async function getConversation(id) {
  const [index, body] = await Promise.all([get(KEYS.index, []), get(KEYS.conv(id), null)]);
  const meta = index.find((m) => m.id === id);
  if (!meta) return null;
  return { ...meta, messages: body?.messages ?? [] };
}

export async function getConversations(ids) {
  const index = await get(KEYS.index, []);
  const keys = ids.map((id) => KEYS.conv(id));
  const bodies = await chrome.storage.local.get(keys);
  return ids
    .map((id) => {
      const meta = index.find((m) => m.id === id);
      return meta ? { ...meta, messages: bodies[KEYS.conv(id)]?.messages ?? [] } : null;
    })
    .filter(Boolean);
}

export async function getAllConversationsFull() {
  const index = await get(KEYS.index, []);
  return getConversations(index.map((m) => m.id));
}

/**
 * Merge an incoming conversation with the stored copy (if any) and return what to write.
 * User metadata (tags, notes, stage, a renamed title…) survives unless `preserveUserFields` is false.
 */
async function mergeConversation(index, conv, { preserveUserFields = true } = {}) {
  const id = conv.id || idForUrl(conv.url) || uid('conv');
  const existing = index.find((m) => m.id === id);
  let messages = (conv.messages ?? []).map(normalizeMessage);
  const merged = {
    ...(existing ?? {}),
    ...conv,
    id,
    createdAt: existing?.createdAt ?? conv.createdAt ?? nowIso(),
    savedAt: existing?.savedAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  if (existing && preserveUserFields) {
    merged.tags = conv.tags?.length ? conv.tags : existing.tags;
    merged.notes = conv.notes || existing.notes;
    merged.favorite = Boolean(conv.favorite || existing.favorite);
    merged.pinned = Boolean(conv.pinned || existing.pinned);
    merged.workspaceId = conv.workspaceId ?? existing.workspaceId;
    merged.workflowStage = conv.workflowStage ?? existing.workflowStage;
    merged.priority = conv.priority ?? existing.priority;
    merged.retentionLevel = conv.retentionLevel ?? existing.retentionLevel;
    merged.liveSync = conv.liveSync ?? existing.liveSync;
    // a title the user renamed wins over the one read from the page
    if (existing.titleEdited) {
      merged.title = existing.title;
      merged.titleEdited = true;
    }
    // never let a visible-only capture replace or downgrade a full-thread capture
    if (existing.captureLevel === 'full' && conv.captureLevel !== 'full') {
      if (messages.length >= existing.messageCount) {
        merged.captureLevel = 'full'; // superset: new messages arrived, everything old is still there
      } else {
        const body = await get(KEYS.conv(id), null);
        if (body?.messages?.length) {
          messages = body.messages;
          merged.captureLevel = 'full';
        }
      }
    }
  }
  merged.messages = messages;
  return { meta: toMeta(merged), messages, isNew: !existing };
}

function upsertIndex(index, meta, isNew) {
  return isNew ? [meta, ...index] : index.map((m) => (m.id === meta.id ? meta : m));
}

/** Insert or update a conversation. Returns the stored metadata. */
export function saveConversation(conv, opts = {}) {
  return locked(async () => {
    const index = await get(KEYS.index, []);
    const { meta, messages, isNew } = await mergeConversation(index, conv, opts);
    await set({ [KEYS.index]: upsertIndex(index, meta, isNew), [KEYS.conv(meta.id)]: { messages } });
    return meta;
  });
}

/**
 * Insert or update many conversations with a single index write (imports, migration).
 * Bodies are flushed in chunks; `onProgress(done, total)` is called as items are processed.
 */
export function saveConversations(list, { preserveUserFields = true, onProgress } = {}) {
  return locked(async () => {
    let index = await get(KEYS.index, []);
    const metas = [];
    let bodies = {};
    let done = 0;
    for (const conv of list) {
      done += 1;
      if (!conv || !Array.isArray(conv.messages)) continue;
      const { meta, messages, isNew } = await mergeConversation(index, conv, { preserveUserFields });
      index = upsertIndex(index, meta, isNew);
      bodies[KEYS.conv(meta.id)] = { messages };
      metas.push(meta);
      if (Object.keys(bodies).length >= 50) {
        await set(bodies);
        bodies = {};
        onProgress?.(done, list.length);
        await new Promise((r) => setTimeout(r, 0)); // let the UI repaint
      }
    }
    await set({ ...bodies, [KEYS.index]: index });
    onProgress?.(list.length, list.length);
    return metas;
  });
}

/** Update metadata only (tags, notes, flags…). */
export function updateConversation(id, patch) {
  return locked(async () => {
    const index = await get(KEYS.index, []);
    const existing = index.find((m) => m.id === id);
    if (!existing) return null;
    const meta = { ...existing, ...patch, id, updatedAt: nowIso() };
    if ('title' in patch) meta.titleEdited = true;
    if ('tags' in patch || 'title' in patch || 'notes' in patch) {
      const body = await get(KEYS.conv(id), { messages: [] });
      Object.assign(meta, toMeta({ ...meta, messages: body.messages }));
    }
    await set({ [KEYS.index]: index.map((m) => (m.id === id ? meta : m)) });
    return meta;
  });
}

/** Replace the message list (e.g. after editing/pruning messages). */
export function replaceMessages(id, messages) {
  return locked(async () => {
    const index = await get(KEYS.index, []);
    const existing = index.find((m) => m.id === id);
    if (!existing) return null;
    const normalized = messages.map(normalizeMessage);
    const meta = toMeta({ ...existing, messages: normalized, updatedAt: nowIso() });
    await set({ [KEYS.index]: index.map((m) => (m.id === id ? meta : m)), [KEYS.conv(id)]: { messages: normalized } });
    return meta;
  });
}

export const TRASH_LIMIT = 20;

/** Soft delete: moves conversations into a small trash ring buffer so they can be undone. */
export function deleteConversations(ids) {
  return locked(async () => {
    const index = await get(KEYS.index, []);
    const wanted = new Set(ids);
    const doomed = index.filter((m) => wanted.has(m.id));
    if (!doomed.length) return;
    const keys = doomed.map((m) => KEYS.conv(m.id));
    const [bodies, trash] = await Promise.all([chrome.storage.local.get(keys), get(KEYS.trash, [])]);
    const deletedAt = nowIso();
    const entries = doomed.map((m) => ({ ...m, messages: bodies[KEYS.conv(m.id)]?.messages ?? [], deletedAt }));
    await set({ [KEYS.index]: index.filter((m) => !wanted.has(m.id)), [KEYS.trash]: [...entries, ...trash].slice(0, TRASH_LIMIT) });
    await remove(keys);
  });
}

export function deleteConversation(id) {
  return deleteConversations([id]);
}

export function restoreFromTrash(id) {
  return locked(async () => {
    const trash = await get(KEYS.trash, []);
    const item = trash.find((t) => t.id === id);
    if (!item) return null;
    const { deletedAt, ...conv } = item;
    const index = await get(KEYS.index, []);
    const { meta, messages, isNew } = await mergeConversation(index, conv, { preserveUserFields: false });
    await set({ [KEYS.index]: upsertIndex(index, meta, isNew), [KEYS.conv(meta.id)]: { messages }, [KEYS.trash]: trash.filter((t) => t.id !== id) });
    return meta;
  });
}

export async function listTrash() {
  return get(KEYS.trash, []);
}

export async function emptyTrash() {
  await set({ [KEYS.trash]: [] });
}

export async function findByUrl(url) {
  const id = idForUrl(url);
  if (!id) return null;
  const index = await get(KEYS.index, []);
  return index.find((m) => m.id === id) ?? null;
}

// ---------- templates ----------

/** Only a missing key means "first run"; an empty list is a user who deleted every prompt. */
export async function listTemplates() {
  const stored = await get(KEYS.templates, null);
  if (Array.isArray(stored)) return stored;
  await set({ [KEYS.templates]: DEFAULT_TEMPLATES });
  return DEFAULT_TEMPLATES;
}

// ---------- validation of external data (backups can be hand-edited or come from another tool) ----------

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function sanitizeTemplate(t) {
  if (!isPlainObject(t)) return null;
  const title = String(t.title ?? '').trim();
  const body = String(t.body ?? '').trim();
  if (!title && !body) return null;
  return { id: typeof t.id === 'string' && t.id ? t.id : uid('template'), title: title || 'Untitled prompt', body, builtIn: Boolean(t.builtIn), updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : undefined };
}

export function sanitizeWorkspace(w) {
  if (!isPlainObject(w)) return null;
  const title = String(w.title ?? '').trim();
  return {
    id: typeof w.id === 'string' && w.id ? w.id : uid('workspace'),
    title: title || 'Untitled workflow',
    goal: String(w.goal ?? ''),
    createdAt: typeof w.createdAt === 'string' ? w.createdAt : nowIso(),
    updatedAt: typeof w.updatedAt === 'string' ? w.updatedAt : nowIso(),
  };
}

/** Only known settings, only with the right type. */
export function sanitizeSettings(s) {
  if (!isPlainObject(s)) return {};
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (key in s && typeof s[key] === typeof def) out[key] = s[key];
  }
  return out;
}

export async function saveTemplate(template) {
  const list = await listTemplates();
  const next = { ...template, id: template.id || uid('template'), updatedAt: nowIso() };
  const i = list.findIndex((t) => t.id === next.id);
  const out = i >= 0 ? list.map((t, j) => (j === i ? next : t)) : [...list, next];
  await set({ [KEYS.templates]: out });
  return next;
}

export async function deleteTemplate(id) {
  const list = await listTemplates();
  await set({ [KEYS.templates]: list.filter((t) => t.id !== id) });
}

export async function resetTemplates() {
  await set({ [KEYS.templates]: DEFAULT_TEMPLATES });
}

// ---------- workspaces ----------

export async function listWorkspaces() {
  return get(KEYS.workspaces, []);
}

export async function saveWorkspace(ws) {
  const list = await listWorkspaces();
  const next = { ...ws, id: ws.id || uid('workspace'), updatedAt: nowIso(), createdAt: ws.createdAt || nowIso() };
  const i = list.findIndex((w) => w.id === next.id);
  const out = i >= 0 ? list.map((w, j) => (j === i ? next : w)) : [next, ...list];
  await set({ [KEYS.workspaces]: out });
  return next;
}

export function deleteWorkspace(id) {
  return locked(async () => {
    const [list, index] = await Promise.all([listWorkspaces(), get(KEYS.index, [])]);
    const nextIndex = index.map((m) => (m.workspaceId === id ? { ...m, workspaceId: undefined } : m));
    await set({ [KEYS.workspaces]: list.filter((w) => w.id !== id), [KEYS.index]: nextIndex });
  });
}

// ---------- settings ----------

export async function getSettings() {
  const stored = await get(KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await set({ [KEYS.settings]: next });
  return next;
}

// ---------- backup / restore ----------

export async function exportBackup() {
  const [index, templates, workspaces, settings] = await Promise.all([
    get(KEYS.index, []),
    listTemplates(),
    listWorkspaces(),
    getSettings(),
  ]);
  const conversations = await getConversations(index.map((m) => m.id));
  return {
    app: 'conversation-bridge',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(),
    conversations,
    templates,
    workspaces,
    settings,
  };
}

/**
 * Import a backup or a list of conversations. Accepts:
 *  - a Conversation Bridge backup ({ conversations, templates, workspaces, settings })
 *  - an array of conversations
 *  - { conversations: [...] } from the old library export
 * Settings are only applied with `applySettings`; `onProgress(done, total)` reports progress.
 */
export async function importBackup(data, { merge = true, applySettings = false, onProgress } = {}) {
  const list = (Array.isArray(data) ? data : data?.conversations ?? []).filter((c) => isPlainObject(c) && Array.isArray(c.messages));
  const metas = await saveConversations(
    list.map((conv) => ({ ...conv, id: typeof conv.id === 'string' && conv.id ? conv.id : idForUrl(conv.url) || uid('conv') })),
    { preserveUserFields: merge, onProgress },
  );
  if (!Array.isArray(data)) {
    const templates = (Array.isArray(data.templates) ? data.templates : []).map(sanitizeTemplate).filter(Boolean);
    if (templates.length) {
      const existing = merge ? await listTemplates() : [];
      const byId = new Map(existing.map((t) => [t.id, t]));
      templates.forEach((t) => byId.set(t.id, t));
      await set({ [KEYS.templates]: Array.from(byId.values()) });
    }
    const workspaces = (Array.isArray(data.workspaces) ? data.workspaces : []).map(sanitizeWorkspace).filter(Boolean);
    if (workspaces.length) {
      const existing = merge ? await listWorkspaces() : [];
      const byId = new Map(existing.map((w) => [w.id, w]));
      workspaces.forEach((w) => byId.set(w.id, w));
      await set({ [KEYS.workspaces]: Array.from(byId.values()) });
    }
    if (applySettings) {
      const settings = sanitizeSettings(data.settings);
      if (Object.keys(settings).length) await updateSettings(settings);
    }
  }
  return metas.length;
}

/** Removes everything the extension ever stored, including keys left behind by 0.x versions. */
export function clearAllData() {
  return locked(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('cb.') || k.startsWith('conversationBridge.'));
    await remove(keys);
    // mark the schema as current so the next update does not try to migrate again
    await set({ [KEYS.meta]: { schemaVersion: SCHEMA_VERSION, installedAt: nowIso() } });
  });
}

export async function storageUsage() {
  if (chrome.storage.local.getBytesInUse) {
    return chrome.storage.local.getBytesInUse(null);
  }
  const all = await chrome.storage.local.get(null);
  return JSON.stringify(all).length;
}

// ---------- migration ----------

export async function migrate() {
  const meta = await get(KEYS.meta, null);
  if (meta?.schemaVersion === SCHEMA_VERSION) return { migrated: 0 };
  const legacy = await chrome.storage.local.get([
    'conversationBridge.conversations',
    'conversationBridge.templates',
    'conversationBridge.workspaces',
  ]);
  let migrated = 0;
  const legacyConvs = legacy['conversationBridge.conversations'];
  if (Array.isArray(legacyConvs) && legacyConvs.length) {
    const metas = await saveConversations(
      legacyConvs.filter((c) => isPlainObject(c)).map((conv) => ({ ...conv, id: idForUrl(conv.url) || conv.id })),
      { preserveUserFields: false },
    );
    migrated = metas.length;
  }
  const legacyTemplates = legacy['conversationBridge.templates'];
  if (Array.isArray(legacyTemplates) && legacyTemplates.length) {
    const custom = legacyTemplates.map(sanitizeTemplate).filter((t) => t && !DEFAULT_TEMPLATES.some((d) => d.id === t.id));
    await set({ [KEYS.templates]: [...DEFAULT_TEMPLATES, ...custom] });
  }
  const legacyWs = legacy['conversationBridge.workspaces'];
  if (Array.isArray(legacyWs) && legacyWs.length) {
    await set({ [KEYS.workspaces]: legacyWs.map(sanitizeWorkspace).filter(Boolean) });
  }
  await set({ [KEYS.meta]: { schemaVersion: SCHEMA_VERSION, installedAt: meta?.installedAt ?? nowIso() } });
  // keep legacy keys for one version so a downgrade does not lose data
  return { migrated };
}
