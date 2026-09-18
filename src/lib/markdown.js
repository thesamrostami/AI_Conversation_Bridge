// Minimal, dependency-free Markdown → HTML renderer.
// Supports: headings, fenced code, inline code, bold/italic/strike, links, images,
// ordered/unordered lists (nested by indentation), blockquotes, tables, hr, paragraphs.
// All text is HTML-escaped; only http(s)/mailto links and http(s) images are emitted.

import { escapeHtml } from './util.js';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function safeUrl(url) {
  const u = String(url ?? '').trim();
  return SAFE_URL.test(u) ? u : '';
}

export function renderInline(text) {
  let s = escapeHtml(text);
  // inline code first so its content is untouched by other rules
  const codes = [];
  s = s.replace(/(`+)([^`\n]+?)\1/g, (_, _b, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0001`;
  });
  // images ![alt](src)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, src) => {
    const url = safeUrl(src);
    return url ? `<img src="${url}" alt="${alt}" loading="lazy">` : `<em>[image${alt ? `: ${alt}` : ''}]</em>`;
  });
  // links [text](href)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, href) => {
    const url = safeUrl(href);
    return url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  // autolinks <https://…> (the URL is already HTML-escaped, so "&amp;" inside it is correct for href)
  s = s.replace(/&lt;(https?:\/\/[^\s<>]+?)&gt;/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  // bold, italic, strike — emphasis markers must hug their text, so "2 * 3 * 4" stays literal
  s = s.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
  // hard line breaks
  s = s.replace(/ {2,}\n/g, '<br>\n');
  s = s.replace(/\u0000(\d+)\u0001/g, (_, i) => codes[Number(i)]);
  return s;
}

function renderTable(lines) {
  const rows = lines.map((l) =>
    l
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.replace(/\\\|/g, '|').trim()),
  );
  const [header, , ...body] = rows;
  const th = header.map((c) => `<th>${renderInline(c)}</th>`).join('');
  const trs = body.map((r) => `<tr>${header.map((_, i) => `<td>${renderInline(r[i] ?? '')}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

const FENCE_RE = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)\s*$/;

function codeBlockHtml(lang, code) {
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<pre data-lang="${escapeHtml(lang)}"><code${cls}>${escapeHtml(code)}</code></pre>`;
}

function renderList(lines, start) {
  // Parse a contiguous list block (with nested items) starting at `start`. Returns [html, nextIndex].
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m) {
      const cur = items[items.length - 1];
      if (cur) {
        // fenced code block indented under the item (as chat captures produce it)
        const fence = FENCE_RE.exec(lines[i]);
        if (fence && fence[1].length >= 2) {
          const indent = fence[1].length;
          const buf = [];
          i += 1;
          while (i < lines.length && !lines[i].trim().startsWith(fence[2])) {
            buf.push(lines[i].slice(Math.min(indent, lines[i].search(/\S|$/))));
            i += 1;
          }
          i += 1;
          cur.blocks.push(codeBlockHtml(fence[3], buf.join('\n')));
          continue;
        }
        // continuation line (indented) belongs to the previous item
        if (/^\s{2,}\S/.test(lines[i])) {
          cur.body.push(lines[i].replace(/^\s{2,}/, ''));
          i += 1;
          continue;
        }
        // a blank line followed by indented content is still inside the item
        if (!lines[i].trim() && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
          i += 1;
          continue;
        }
      }
      break;
    }
    items.push({ indent: m[1].length, marker: m[2], text: m[3], body: [], blocks: [] });
    i += 1;
  }
  const html = buildList(items, 0, items.length ? items[0].indent : 0)[0];
  return [html, i];
}

function buildList(items, from, indent) {
  const ordered = /\d/.test(items[from]?.marker ?? '');
  const tag = ordered ? 'ol' : 'ul';
  let out = `<${tag}>`;
  let i = from;
  while (i < items.length && items[i].indent >= indent) {
    if (items[i].indent > indent) {
      const [nested, next] = buildList(items, i, items[i].indent);
      out = out.replace(/<\/li>$/, `${nested}</li>`);
      i = next;
      continue;
    }
    const it = items[i];
    const task = /^\[([ xX])\]\s+/.exec(it.text);
    let text = it.text;
    let cls = '';
    if (task) {
      text = text.slice(task[0].length);
      cls = ` class="task${task[1] === ' ' ? '' : ' done'}"`;
    }
    const extra = it.body.length ? `<br>${renderInline(it.body.join('\n'))}` : '';
    out += `<li${cls}>${renderInline(text)}${extra}${it.blocks.join('')}</li>`;
    i += 1;
  }
  return [`${out}</${tag}>`, i];
}

export function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push(`<p>${renderInline(para.join('\n'))}</p>`);
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      const close = fence[2];
      const buf = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(close)) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(codeBlockHtml(fence[3], buf.join('\n')));
      continue;
    }
    // math block $$
    if (/^\s*\$\$\s*$/.test(line)) {
      flush();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<pre class="math">${escapeHtml(buf.join('\n'))}</pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`);
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush();
      const buf = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        buf.push(lines[i]);
        i += 1;
      }
      out.push(renderTable(buf));
      continue;
    }
    if (LIST_RE.test(line)) {
      flush();
      const [html, next] = renderList(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flush();
  return out.join('\n');
}

/** Strip Markdown syntax for plain-text output / previews. */
export function markdownToPlain(md) {
  return String(md ?? '')
    .replace(/```[\w+#.-]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[image $1]')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(?=\S)(.*?\S)\1/g, '$2')
    .replace(/(^|\W)([*_])(?=\S)(.*?\S)\2(?=\W|$)/g, '$1$3')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
