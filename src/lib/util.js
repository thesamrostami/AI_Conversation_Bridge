// Small shared helpers used by the side panel, background worker and exporters.

export function uid(prefix = 'item') {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}_${Array.from(rand).map((n) => n.toString(36)).join('')}`;
}

/** Stable, short hash (FNV-1a) used to derive conversation ids from URLs. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function slugify(str, fallback = 'conversation') {
  return (
    String(str ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || fallback
  );
}

/** Safe file name: strips characters that are illegal on Windows/macOS (including both slashes). */
export function safeFilename(str, fallback = 'conversation') {
  const cleaned = String(str ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, ''); // Windows rejects trailing dots/spaces
  return cleaned || fallback;
}

/** Only http(s) URLs are safe to emit as links (imports could carry javascript: etc.). */
export function safeHttpUrl(url) {
  const u = String(url ?? '').trim();
  return /^https?:\/\//i.test(u) ? u : '';
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatDate(iso, opts = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', ...opts });
}

export function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

export function plural(n, singular, pluralWord = `${singular}s`) {
  return `${n} ${n === 1 ? singular : pluralWord}`;
}

export function wordCount(text) {
  return (String(text ?? '').match(/\S+/g) ?? []).length;
}

/** Rough token estimate (≈ 4 chars/token for English, tuned for mixed content). */
export function estimateTokens(text) {
  const s = String(text ?? '');
  return Math.ceil(s.length / 3.8);
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function truncate(str, max = 120) {
  const s = String(str ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function toggleInSet(set, value) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function parseTags(input) {
  return Array.from(
    new Set(
      String(input ?? '')
        .split(/[,\n]/)
        .map((t) => t.trim().replace(/^#/, ''))
        .filter(Boolean)
        .map((t) => t.slice(0, 40)),
    ),
  );
}

export const PLATFORMS = {
  chatgpt: { label: 'ChatGPT', newChat: 'https://chatgpt.com/', color: '#10a37f' },
  claude: { label: 'Claude', newChat: 'https://claude.ai/new', color: '#d97757' },
  gemini: { label: 'Gemini', newChat: 'https://gemini.google.com/app', color: '#4285f4' },
  perplexity: { label: 'Perplexity', newChat: 'https://www.perplexity.ai/', color: '#20808d' },
  other: { label: 'Other', newChat: '', color: '#6b7280' },
};

export function platformLabel(id) {
  return PLATFORMS[id]?.label ?? (id ? id[0].toUpperCase() + id.slice(1) : 'Unknown');
}

export const STAGES = { inbox: 'Inbox', active: 'Active', review: 'Review', complete: 'Done' };
export const PRIORITIES = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' };
export const RETENTION = { working: 'Working', reference: 'Reference', permanent: 'Keep' };
export const FORMATS = { markdown: 'Markdown', plain: 'Plain text', json: 'JSON', html: 'HTML', pdf: 'PDF' };
