// Conversation → file content in several formats.

import { escapeHtml, formatDate, platformLabel, safeFilename, safeHttpUrl, wordCount, estimateTokens } from './util.js';
import { renderMarkdown, markdownToPlain } from './markdown.js';

function roleLabel(m) {
  return m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : 'Assistant';
}

function selectMessages(conv, opts) {
  let msgs = conv.messages ?? [];
  if (opts.selectedIds) msgs = msgs.filter((m) => opts.selectedIds.has(m.id));
  if (!opts.includeSystemMessages) msgs = msgs.filter((m) => m.role !== 'system');
  return msgs;
}

function yamlString(s) {
  return JSON.stringify(String(s ?? ''));
}

export function frontmatterFor(conv, msgs) {
  const lines = [
    '---',
    `title: ${yamlString(conv.title)}`,
    `source: ${yamlString(conv.url)}`,
    `platform: ${conv.platform}`,
    `created: ${conv.createdAt}`,
    `updated: ${conv.updatedAt}`,
    `messages: ${msgs.length}`,
    `words: ${wordCount(msgs.map((m) => m.content).join(' '))}`,
  ];
  const tags = [...(conv.tags ?? [])];
  if (tags.length) lines.push('tags:', ...tags.map((t) => `  - ${yamlString(t)}`));
  if (conv.autoTags?.length) lines.push(`topics: [${conv.autoTags.map(yamlString).join(', ')}]`);
  if (conv.workflowStage) lines.push(`stage: ${conv.workflowStage}`);
  if (conv.priority) lines.push(`priority: ${conv.priority}`);
  if (conv.notes) lines.push(`notes: ${yamlString(conv.notes)}`);
  lines.push('tool: Conversation Bridge', '---', '');
  return lines.join('\n');
}

export function toMarkdown(conv, opts = {}) {
  const msgs = selectMessages(conv, opts);
  const head = [];
  if (opts.frontmatter) head.push(frontmatterFor(conv, msgs));
  head.push(`# ${conv.title}`, '');
  if (!opts.frontmatter) {
    head.push(
      `- Platform: ${platformLabel(conv.platform)}`,
      `- Source: ${conv.url}`,
      `- Captured: ${formatDate(conv.createdAt)}`,
      `- Messages: ${msgs.length}`,
    );
    if (conv.tags?.length) head.push(`- Tags: ${conv.tags.join(', ')}`);
    if (conv.notes) head.push(`- Notes: ${conv.notes}`);
    head.push('');
  }
  const body = msgs.map((m) => {
    const ts = opts.includeTimestamps && m.timestamp ? ` <sub>${formatDate(m.timestamp)}</sub>` : '';
    return `## ${roleLabel(m)}${ts}\n\n${m.content}\n`;
  });
  let out = [...head, ...body].join('\n');
  if (opts.appendPrompt) out += `\n---\n\n${opts.appendPrompt}\n`;
  return out;
}

export function toPlain(conv, opts = {}) {
  const msgs = selectMessages(conv, opts);
  const head = [conv.title, `Platform: ${platformLabel(conv.platform)}`, `Source: ${conv.url}`, `Captured: ${formatDate(conv.createdAt)}`];
  if (conv.tags?.length) head.push(`Tags: ${conv.tags.join(', ')}`);
  if (conv.notes) head.push(`Notes: ${conv.notes}`);
  head.push(''); // blank line between the header and the first message
  const body = msgs.flatMap((m) => [`${roleLabel(m).toUpperCase()}${opts.includeTimestamps && m.timestamp ? ` (${formatDate(m.timestamp)})` : ''}`, markdownToPlain(m.content), '']);
  let out = [...head, ...body].join('\n');
  if (opts.appendPrompt) out += `\n---\n${opts.appendPrompt}\n`;
  return out;
}

export function toJson(conv, opts = {}) {
  const msgs = selectMessages(conv, opts);
  const { messages: _m, ...rest } = conv;
  return JSON.stringify({ ...rest, messages: msgs, exportedAt: new Date().toISOString(), exporter: 'Conversation Bridge' }, null, 2);
}

const HTML_CSS = `
  :root { color-scheme: light dark; --fg:#1c1917; --muted:#57534e; --bg:#fff; --card:#fafaf9; --line:#e7e5e4; --user:#eef2ff; --code:#f5f5f4; --accent:#4f46e5; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f5f5f4; --muted:#a8a29e; --bg:#0c0a09; --card:#1c1917; --line:#292524; --user:#1e1b4b; --code:#171412; --accent:#a5b4fc; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  header h1 { font-size: 1.7rem; margin: 0 0 6px; line-height: 1.25; }
  header .meta { color: var(--muted); font-size: .85rem; display: flex; flex-wrap: wrap; gap: 6px 14px; }
  header .meta a { color: inherit; }
  .tags span { display: inline-block; background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 1px 10px; font-size: .78rem; margin: 8px 6px 0 0; }
  .notes { margin-top: 12px; padding: 10px 14px; background: var(--card); border-left: 3px solid var(--accent); border-radius: 6px; font-size: .9rem; }
  .msg { margin-top: 22px; border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; background: var(--card); page-break-inside: avoid; }
  .msg.user { background: var(--user); }
  .msg .role { font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; display:flex; justify-content: space-between; }
  .msg > :nth-child(2) { margin-top: 0; }
  .msg > :last-child { margin-bottom: 0; }
  pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; font-size: .85rem; line-height: 1.5; position: relative; }
  pre[data-lang]:not([data-lang=""])::before { content: attr(data-lang); position: absolute; top: 4px; right: 10px; font-size: .68rem; color: var(--muted); text-transform: lowercase; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  :not(pre) > code { background: var(--code); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; font-size: .88em; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: .9rem; }
  th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: var(--code); }
  blockquote { margin: 12px 0; padding: 4px 14px; border-left: 3px solid var(--line); color: var(--muted); }
  img { max-width: 100%; border-radius: 8px; }
  a { color: var(--accent); }
  li.task { list-style: none; margin-left: -1.2em; } li.task::before { content: "☐ "; } li.task.done::before { content: "☑ "; }
  footer { margin-top: 40px; color: var(--muted); font-size: .78rem; text-align: center; }
  @media print { body { background: #fff; color: #000; } .wrap { max-width: none; padding: 0; } .msg { break-inside: avoid; } a { color: inherit; } footer { display: none; } }
`;

export function toHtml(conv, opts = {}) {
  const msgs = selectMessages(conv, opts);
  const messages = msgs
    .map((m) => {
      const ts = opts.includeTimestamps && m.timestamp ? `<span>${escapeHtml(formatDate(m.timestamp))}</span>` : '';
      return `<article class="msg ${m.role}"><div class="role"><span>${roleLabel(m)}</span>${ts}</div>${renderMarkdown(m.content)}</article>`;
    })
    .join('\n');
  const tags = conv.tags?.length ? `<div class="tags">${conv.tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join('')}</div>` : '';
  const notes = conv.notes ? `<div class="notes">${escapeHtml(conv.notes).replace(/\n/g, '<br>')}</div>` : '';
  const prompt = opts.appendPrompt ? `<article class="msg"><div class="role"><span>Prompt</span></div>${renderMarkdown(opts.appendPrompt)}</article>` : '';
  const words = wordCount(msgs.map((m) => m.content).join(' '));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(conv.title)}</title>
<style>${HTML_CSS}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${escapeHtml(conv.title)}</h1>
  <div class="meta">
    <span>${escapeHtml(platformLabel(conv.platform))}</span>
    <span>${escapeHtml(formatDate(conv.createdAt))}</span>
    <span>${msgs.length} messages · ${words} words · ~${estimateTokens(msgs.map((m) => m.content).join(' '))} tokens</span>
    ${safeHttpUrl(conv.url) ? `<a href="${escapeHtml(safeHttpUrl(conv.url))}" rel="noopener noreferrer">Open original</a>` : ''}
  </div>
  ${tags}${notes}
</header>
${messages}
${prompt}
<footer>Exported with Conversation Bridge</footer>
</div>
</body>
</html>`;
}

export function exportConversation(conv, format, opts = {}) {
  switch (format) {
    case 'plain':
      return toPlain(conv, opts);
    case 'json':
      return toJson(conv, opts);
    case 'html':
    case 'pdf':
      return toHtml(conv, opts);
    default:
      return toMarkdown(conv, opts);
  }
}

export function extensionFor(format) {
  return { markdown: 'md', plain: 'txt', json: 'json', html: 'html', pdf: 'html' }[format] ?? 'md';
}

export function mimeFor(format) {
  return { markdown: 'text/markdown', plain: 'text/plain', json: 'application/json', html: 'text/html', pdf: 'text/html' }[format] ?? 'text/plain';
}

/** Build a file name from a template such as "{date} {title}". */
export function filenameFor(conv, template = '{date} {title}', ext = 'md') {
  const d = new Date(conv.createdAt ?? Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const vars = {
    title: conv.title ?? 'conversation',
    platform: platformLabel(conv.platform),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
    id: (conv.id ?? '').replace(/^conv_/, ''),
    messages: String(conv.messages?.length ?? conv.messageCount ?? 0),
  };
  const name = String(template || '{title}').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  return `${safeFilename(name)}.${ext}`;
}

/** Combine several conversations into one Markdown document. */
export function toCombinedMarkdown(convs, opts = {}) {
  return convs.map((c) => toMarkdown(c, opts)).join('\n\n---\n\n');
}

export function toLibraryJson(convs) {
  return JSON.stringify({ app: 'conversation-bridge', exportedAt: new Date().toISOString(), conversations: convs }, null, 2);
}
