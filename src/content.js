// Conversation Bridge — content script.
// Runs on supported chat sites. Extracts the visible conversation as Markdown, performs deep scans,
// inserts text into the composer for hand-offs, and notifies the extension about navigation.
// Classic script (not a module) because Chrome injects content scripts as plain scripts.

(() => {
  if (window.__conversationBridgeLoaded) return;
  window.__conversationBridgeLoaded = true;

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  const PH_START = '\u0000';
  const PH_END = '\u0001';

  function uid(prefix = 'item') {
    const rand = crypto.getRandomValues(new Uint32Array(2));
    return `${prefix}_${Date.now().toString(36)}_${Array.from(rand).map((n) => n.toString(36)).join('')}`;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 20 && rect.height > 16;
  }

  function cleanTitle(raw) {
    return String(raw ?? '')
      .replace(/\s*[-|–—:]\s*(ChatGPT|Claude|Gemini|Perplexity|Google Gemini)\s*$/i, '')
      .replace(/^\s*(ChatGPT|Claude|Gemini|Perplexity)\s*[-|–—:]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const KNOWN_LANGS = new Set(
    `javascript js typescript ts python py java c cpp c++ csharp c# cs go golang rust rs ruby rb php swift kotlin kt scala html css scss sass less json
     yaml yml xml sql mysql postgresql postgres sqlite plsql tsql bash sh shell zsh fish powershell ps1 pwsh bat cmd dockerfile docker makefile cmake
     markdown md text plaintext txt jsx tsx r matlab lua perl dart elixir erlang haskell clojure ocaml fsharp toml ini nginx apache graphql gql proto
     protobuf diff patch http latex tex bibtex vue svelte astro solidity assembly asm nasm objective-c objectivec objc groovy gradle terraform hcl mermaid
     csv tsv regex applescript vb vba vbnet fortran cobol prolog scheme lisp racket nim zig julia wasm wat arduino verilog vhdl mongodb cypher sparql
     handlebars hbs pug jade ejs jinja jinja2 django twig blade liquid razor cshtml xaml kql abap apex bicep jsonc json5 ndjson env properties
     gitignore htaccess svg mathematica wolfram stata sas spss octave scilab awk sed tcl ada d crystal elm purescript reason rescript coffeescript
     coffee livescript dart flutter kusto dax m q kdb smalltalk pascal delphi basic freebasic gherkin cucumber cypher plantuml dot graphviz nix
     puppet ansible vagrant jsonl log console output`
      .split(/\s+/)
      .filter(Boolean),
  );

  // ------------------------------------------------------------------
  // DOM → Markdown
  // ------------------------------------------------------------------

  const SKIP_SELECTOR = [
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'canvas',
    'button',
    'input',
    'select',
    'textarea',
    'audio',
    'video',
    'iframe',
    '[aria-hidden="true"]',
    '[hidden]',
    '.sr-only',
    '[role="tooltip"]',
    '[role="button"]',
    '[role="menu"]',
    '[data-cb-skip]',
    '.code-block-decoration', // Gemini code header (language label + buttons)
  ].join(',');

  function detectLanguage(pre, code) {
    const cls = `${code?.className ?? ''} ${pre.className ?? ''}`;
    const m = /(?:language|lang)-([\w+#.-]+)/i.exec(cls);
    if (m) return m[1].toLowerCase();
    for (const el of [code, pre, pre.parentElement, pre.parentElement?.parentElement]) {
      const attr = el?.getAttribute?.('data-language') || el?.getAttribute?.('data-lang') || el?.getAttribute?.('lang-name');
      if (attr && attr.length < 24) return attr.toLowerCase();
    }
    // Look for a short label inside the <pre> (ChatGPT) or in a header next to it (Gemini, Claude).
    const containers = [pre];
    for (let el = pre.parentElement, i = 0; el && i < 4; el = el.parentElement, i += 1) containers.push(el);
    for (const container of containers) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (code && code.contains(node)) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest('button')) return NodeFilter.FILTER_REJECT;
          return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      const first = walker.nextNode();
      if (!first) continue;
      const token = first.textContent.trim().toLowerCase();
      if (/^[a-z0-9+#.-]{1,20}$/.test(token) && (KNOWN_LANGS.has(token) || token.length <= 12)) return token;
    }
    return '';
  }

  function inlineCode(text) {
    const t = String(text ?? '').replace(/\n+/g, ' ');
    if (!t) return '';
    if (!t.includes('`')) return `\`${t}\``;
    const longest = Math.max(...(t.match(/`+/g) ?? ['']).map((s) => s.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence} ${t} ${fence}`;
  }

  function wrapInline(inner, marker) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    if (!m || !m[2]) return inner;
    return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
  }

  function absoluteUrl(href) {
    try {
      return new URL(href, location.href).href;
    } catch {
      return '';
    }
  }

  function mathFrom(el) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"], annotation');
    const tex = ann?.textContent?.trim();
    if (!tex) return null;
    const display = el.classList.contains('katex-display') || el.closest('.katex-display') || el.getAttribute('display') === 'block';
    return display ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
  }

  class MarkdownConverter {
    constructor() {
      this.protected = [];
    }

    protect(text) {
      this.protected.push(text);
      return `${PH_START}${this.protected.length - 1}${PH_END}`;
    }

    restore(text) {
      const re = new RegExp(`${PH_START}(\\d+)${PH_END}`, 'g');
      let out = text;
      // placeholders can nest (inline code inside a list), so resolve until none remain
      for (let pass = 0; pass < 6 && re.test(out); pass += 1) {
        re.lastIndex = 0;
        out = out.replace(re, (_, i) => this.protected[Number(i)] ?? '');
      }
      return out;
    }

    convert(root) {
      const raw = this.walkChildren(root, { pre: false, preWrap: false });
      return this.finalize(raw);
    }

    finalize(raw) {
      let text = raw
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n[ \t]+(?=\S)/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      text = this.restore(text);
      return text.replace(/\n{3,}/g, '\n\n').trim();
    }

    walkChildren(el, ctx) {
      let out = '';
      for (const node of el.childNodes) out += this.walk(node, ctx);
      return out;
    }

    text(node, ctx) {
      const t = node.textContent ?? '';
      if (ctx.pre) return t;
      if (ctx.preWrap) return t.replace(/[ \t]+/g, ' ');
      return t.replace(/\s+/g, ' ');
    }

    walk(node, ctx) {
      if (node.nodeType === Node.TEXT_NODE) return this.text(node, ctx);
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node;
      if (el.matches(SKIP_SELECTOR)) return '';
      const tag = el.tagName.toLowerCase();

      if (el.classList.contains('katex') || tag === 'math') {
        const math = mathFrom(el);
        if (math) return math;
        if (tag === 'math') return this.walkChildren(el, ctx);
        return '';
      }
      if (el.classList.contains('katex-display')) {
        const math = mathFrom(el);
        return math ?? this.walkChildren(el, ctx);
      }

      switch (tag) {
        case 'pre':
          return this.codeBlock(el);
        case 'code':
          return ctx.pre ? this.walkChildren(el, ctx) : this.protect(inlineCode(el.textContent));
        case 'br':
          return '\n';
        case 'hr':
          return '\n\n---\n\n';
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          const inner = this.walkChildren(el, ctx).trim();
          return inner ? `\n\n${'#'.repeat(Number(tag[1]))} ${inner}\n\n` : '';
        }
        case 'p':
          return `\n\n${this.walkChildren(el, { ...ctx, preWrap: ctx.preWrap || /whitespace-pre/.test(el.className) })}\n\n`;
        case 'div':
        case 'section':
        case 'article':
        case 'main':
        case 'header':
        case 'footer':
        case 'aside':
        case 'figure':
        case 'figcaption':
        case 'message-content':
        case 'user-query':
        case 'model-response':
        case 'response-element': {
          const preWrap = ctx.preWrap || /whitespace-pre/.test(el.className);
          return `\n${this.walkChildren(el, { ...ctx, preWrap })}\n`;
        }
        case 'ul':
        case 'ol':
          return `\n\n${this.protect(this.list(el, 0, ctx))}\n\n`;
        case 'li':
          return this.walkChildren(el, ctx);
        case 'blockquote': {
          // restore nested code first so every line gets the prefix; protect the result from the final whitespace clean-up
          const inner = this.restore(this.finalizeInner(this.walkChildren(el, ctx)));
          const quoted = inner
            .split('\n')
            .map((l) => (l ? `> ${l}` : '>'))
            .join('\n');
          return `\n\n${this.protect(quoted)}\n\n`;
        }
        case 'table':
          return `\n\n${this.protect(this.table(el, ctx))}\n\n`;
        case 'a':
          return this.link(el, ctx);
        case 'img':
          return this.image(el);
        case 'strong':
        case 'b':
          return wrapInline(this.walkChildren(el, ctx), '**');
        case 'em':
        case 'i':
          return wrapInline(this.walkChildren(el, ctx), '*');
        case 'del':
        case 's':
        case 'strike':
          return wrapInline(this.walkChildren(el, ctx), '~~');
        case 'u':
        case 'mark':
        case 'span':
        case 'small':
        case 'label':
        case 'font':
        case 'abbr':
        case 'cite':
        case 'q':
        case 'time':
        case 'kbd':
        case 'samp':
        case 'var':
        case 'bdi':
        case 'bdo':
        case 'wbr':
          return this.walkChildren(el, { ...ctx, preWrap: ctx.preWrap || /whitespace-pre/.test(el.className) });
        case 'sup': {
          const inner = this.walkChildren(el, ctx).trim();
          if (!inner) return '';
          return /^\d{1,3}$/.test(inner) ? `[${inner}]` : `^${inner}^`;
        }
        case 'sub': {
          const inner = this.walkChildren(el, ctx).trim();
          return inner ? `~${inner}~` : '';
        }
        case 'details': {
          const summary = el.querySelector(':scope > summary');
          const title = summary ? this.walkChildren(summary, ctx).trim() : '';
          const body = Array.from(el.childNodes)
            .filter((n) => n !== summary)
            .map((n) => this.walk(n, ctx))
            .join('');
          return `\n\n${title ? `**${title}**\n\n` : ''}${body}\n\n`;
        }
        case 'summary':
          return '';
        case 'dl':
          return `\n\n${this.walkChildren(el, ctx)}\n\n`;
        case 'dt':
          return `\n**${this.walkChildren(el, ctx).trim()}**\n`;
        case 'dd':
          return `\n: ${this.walkChildren(el, ctx).trim()}\n`;
        default:
          return this.walkChildren(el, ctx);
      }
    }

    finalizeInner(raw) {
      return raw
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    codeBlock(pre) {
      const code = pre.querySelector('code') ?? pre;
      let text = code.textContent ?? '';
      text = text.replace(/\r/g, '').replace(/\n+$/, '').replace(/^\n+/, '');
      const lang = detectLanguage(pre, code === pre ? null : code);
      const fenceLen = Math.max(3, ...(text.match(/`{3,}/g) ?? []).map((s) => s.length + 1));
      const fence = '`'.repeat(fenceLen);
      return `\n\n${this.protect(`${fence}${lang}\n${text}\n${fence}`)}\n\n`;
    }

    list(el, depth, ctx) {
      const ordered = el.tagName.toLowerCase() === 'ol';
      const start = Number(el.getAttribute('start') ?? 1) || 1;
      const indent = '  '.repeat(depth);
      const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'li');
      const lines = [];
      items.forEach((li, i) => {
        const marker = ordered ? `${start + i}. ` : '- ';
        let text = '';
        const nested = [];
        for (const child of li.childNodes) {
          if (child.nodeType === Node.ELEMENT_NODE && /^(ul|ol)$/i.test(child.tagName)) nested.push(child);
          else text += this.walk(child, ctx);
        }
        // restore nested code before indenting so every fence line is indented (the caller protects the whole list)
        let body = this.restore(this.finalizeInner(text));
        const checkbox = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"], :scope > label > input[type="checkbox"]');
        if (checkbox) body = `[${checkbox.checked ? 'x' : ' '}] ${body}`;
        const continuation = `${indent}${' '.repeat(marker.length)}`;
        const bodyLines = body.split('\n');
        lines.push(`${indent}${marker}${bodyLines[0] ?? ''}`);
        bodyLines.slice(1).forEach((l) => lines.push(l ? `${continuation}${l}` : ''));
        nested.forEach((n) => lines.push(this.list(n, depth + 1, ctx)));
      });
      return lines.join('\n');
    }

    table(table, ctx) {
      const rows = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table);
      if (!rows.length) return '';
      // cells cannot hold blocks: restore any nested code/list first so it is flattened with the rest
      const cellText = (cell) =>
        this.restore(this.finalizeInner(this.walkChildren(cell, ctx)))
          .replace(/\n+/g, ' ')
          .replace(/\|/g, '\\|')
          .trim();
      const matrix = rows.map((tr) => Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName)).map(cellText));
      const width = Math.max(...matrix.map((r) => r.length));
      if (!width) return '';
      const pad = (r) => [...r, ...Array(width - r.length).fill('')];
      const [head, ...body] = matrix.map(pad);
      const out = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
      body.forEach((r) => out.push(`| ${r.join(' | ')} |`));
      return out.join('\n');
    }

    link(el, ctx) {
      const text = this.walkChildren(el, ctx).trim();
      const href = absoluteUrl(el.getAttribute('href') ?? '');
      if (!href || /^(javascript|blob|data):/i.test(href)) return text;
      if (!text) return `<${href}>`;
      if (text === href || text === href.replace(/^https?:\/\//, '')) return `<${href}>`;
      return `[${text}](${href})`;
    }

    image(el) {
      const alt = (el.getAttribute('alt') ?? '').trim();
      const src = el.currentSrc || el.getAttribute('src') || '';
      const w = Number(el.getAttribute('width') || el.naturalWidth || el.clientWidth || 0);
      const h = Number(el.getAttribute('height') || el.naturalHeight || el.clientHeight || 0);
      if (w && h && (w < 32 || h < 32)) return '';
      if (/avatar|icon|emoji|logo/i.test(`${el.className} ${alt}`)) return '';
      const usable = /^https?:/i.test(src) ? src : 'image';
      return `![${alt || 'image'}](${usable})`;
    }
  }

  function elementToMarkdown(el) {
    return new MarkdownConverter().convert(el);
  }

  // ------------------------------------------------------------------
  // platform adapters
  // ------------------------------------------------------------------

  function documentOrder(a, b) {
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function innermost(items) {
    return items.filter(({ el }) => !items.some((other) => other.el !== el && el.contains(other.el)));
  }

  function outermost(items) {
    return items.filter(({ el }) => !items.some((other) => other.el !== el && other.el.contains(el)));
  }

  function guessRole(el, index) {
    const hint = [el.getAttribute('data-message-author-role'), el.getAttribute('data-testid'), el.getAttribute('aria-label'), el.className]
      .join(' ')
      .toLowerCase();
    if (/user|query|prompt|human/.test(hint)) return 'user';
    if (/assistant|model|response|answer|claude|bot/.test(hint)) return 'assistant';
    return index % 2 === 0 ? 'user' : 'assistant';
  }

  const GENERIC_TURN_SELECTOR = [
    '[data-message-author-role]',
    "[data-testid*='message' i]",
    "[data-testid*='query' i]",
    "[data-testid*='response' i]",
    'user-query',
    'model-response',
    'main article',
    'main .prose',
  ].join(',');

  // Perplexity's own section labels, which are headings but not user queries.
  const PERPLEXITY_SECTION_HEADINGS = /^(answer|sources|related|images|videos|steps|pro search|reasoning|thinking|search results|people also ask|discover|library|spaces)$/i;

  const adapters = [
    {
      id: 'chatgpt',
      matches: (h) => h === 'chatgpt.com' || h === 'chat.openai.com',
      turns() {
        // Roles seen on chatgpt.com: user, assistant, system (hidden custom instructions) and
        // tool (search/browsing scaffolding). Tool turns are not conversation content.
        return Array.from(document.querySelectorAll('[data-message-author-role]'))
          .map((el) => ({ el, role: el.getAttribute('data-message-author-role'), id: el.getAttribute('data-message-id') || undefined }))
          .filter((t) => t.role === 'user' || t.role === 'assistant' || t.role === 'system');
      },
      contentRoot: (el) => el,
      title: () => cleanTitle(document.title),
    },
    {
      id: 'claude',
      matches: (h) => h === 'claude.ai',
      mergeConsecutive: true,
      turns() {
        const users = Array.from(document.querySelectorAll('[data-testid="user-message"]')).map((el) => ({ el, role: 'user' }));
        const assistants = Array.from(document.querySelectorAll('.font-claude-message, .font-claude-response, [data-is-streaming]')).map((el) => ({
          el,
          role: 'assistant',
        }));
        return innermost([...users, ...assistants]).sort((a, b) => documentOrder(a.el, b.el));
      },
      contentRoot: (el) => el,
      title: () => cleanTitle(document.title),
    },
    {
      id: 'gemini',
      matches: (h) => h === 'gemini.google.com',
      turns() {
        const users = Array.from(document.querySelectorAll('user-query')).map((el) => ({ el, role: 'user' }));
        const assistants = Array.from(document.querySelectorAll('model-response')).map((el) => ({ el, role: 'assistant' }));
        return outermost([...users, ...assistants]).sort((a, b) => documentOrder(a.el, b.el));
      },
      contentRoot(el) {
        if (el.tagName.toLowerCase() === 'user-query') return el.querySelector('.query-text, [class*="query-text"]') ?? el;
        return el.querySelector('message-content, .markdown, [class*="response-content"]') ?? el;
      },
      title: () => cleanTitle(document.title),
    },
    {
      id: 'perplexity',
      matches: (h) => h === 'www.perplexity.ai' || h === 'perplexity.ai',
      turns() {
        const main = document.querySelector('main') ?? document.body;
        const outsideThread = '.prose, [class*="prose"], nav, aside, header, footer, form, [contenteditable="true"]';
        const answers = Array.from(main.querySelectorAll('.prose, [class*="prose"]'))
          .filter((el) => !el.closest('form, [contenteditable="true"]'))
          .map((el) => ({ el, role: 'assistant' }));
        const hasText = (el) => (el.textContent ?? '').trim().length > 0;
        // Prefer elements the site itself marks as the query; only fall back to headings when
        // there are none, and skip the page's own section headings.
        let queries = Array.from(main.querySelectorAll('[class*="query" i], [data-testid*="query" i]')).filter((el) => !el.closest(outsideThread) && hasText(el));
        if (!queries.length) {
          queries = Array.from(main.querySelectorAll('h1, h2'))
            .filter((el) => !el.closest(outsideThread) && hasText(el))
            .filter((el) => !PERPLEXITY_SECTION_HEADINGS.test((el.textContent ?? '').trim()));
        }
        return outermost([...queries.map((el) => ({ el, role: 'user' })), ...answers]).sort((a, b) => documentOrder(a.el, b.el));
      },
      contentRoot: (el) => el,
      title: () => cleanTitle(document.title),
    },
  ];

  function currentAdapter() {
    return adapters.find((a) => a.matches(location.hostname)) ?? null;
  }

  function genericTurns() {
    return Array.from(document.querySelectorAll(GENERIC_TURN_SELECTOR))
      .filter((el) => (el.textContent ?? '').trim().length > 12)
      .map((el, i) => ({ el, role: guessRole(el, i) }));
  }

  function turnsToMessages(turns, adapter) {
    const messages = [];
    turns.forEach((turn, i) => {
      const root = adapter?.contentRoot ? adapter.contentRoot(turn.el) : turn.el;
      const content = elementToMarkdown(root);
      if (!content) return;
      const prev = messages[messages.length - 1];
      if (adapter?.mergeConsecutive && prev && prev.role === turn.role) {
        prev.content = `${prev.content}\n\n${content}`;
        return;
      }
      if (prev && prev.role === turn.role && prev.content === content) return; // duplicate node
      messages.push({ id: turn.id ? `msg_${fnv(turn.id)}` : positionalId(i, turn.role, content), role: turn.role, content, index: i, stableId: Boolean(turn.id) });
    });
    return messages;
  }

  // Without a site-provided id, a message is identified by its position in the thread.
  function positionalId(index, role, content) {
    return `msg_${fnv(`${index}:${role}:${content.slice(0, 200)}`)}`;
  }

  // `stableId` only matters while merging deep-scan windows; keep it out of captures.
  function publicMessage({ stableId, ...m }) {
    return m;
  }

  function extractConversation() {
    const adapter = currentAdapter();
    let turns = adapter ? adapter.turns() : [];
    if (!turns.length) turns = outermost(genericTurns());
    const messages = turnsToMessages(turns, adapter).map(publicMessage);
    if (!messages.length) return null;
    const firstUser = messages.find((m) => m.role === 'user');
    let title = adapter?.title() || cleanTitle(document.title);
    if (!title || /^(chatgpt|claude|gemini|perplexity|new chat)$/i.test(title)) {
      title = (firstUser?.content ?? messages[0].content).replace(/\s+/g, ' ').slice(0, 80).trim();
    }
    const now = new Date().toISOString();
    return {
      title: title || 'Untitled conversation',
      platform: adapter?.id ?? 'other',
      url: location.href,
      createdAt: now,
      updatedAt: now,
      messages,
      captureLevel: 'quick',
      tags: [],
      notes: '',
    };
  }

  // ------------------------------------------------------------------
  // deep scan (scrolls the thread so lazily loaded messages render)
  // ------------------------------------------------------------------

  const TURN_PROBE = [
    '[data-message-author-role]',
    '[data-testid="user-message"]',
    '.font-claude-message',
    '.font-claude-response',
    'user-query',
    'model-response',
    'main .prose',
  ].join(',');

  function findScroller() {
    const docEl = document.scrollingElement ?? document.documentElement;
    const candidates = Array.from(document.querySelectorAll('main, [role="main"], [class*="scroll" i], [class*="overflow" i], div'))
      .filter((el) => {
        const style = getComputedStyle(el);
        const scrollable = /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`);
        return el.scrollHeight > el.clientHeight + 300 && el.clientHeight > 250 && (scrollable || el.scrollTop > 0) && el.querySelectorAll(TURN_PROBE).length > 0;
      })
      .map((el) => ({ el, score: el.querySelectorAll(TURN_PROBE).length * 100000 + el.scrollHeight }))
      .sort((a, b) => b.score - a.score);
    const el = candidates[0]?.el;
    if (el) {
      return {
        getTop: () => el.scrollTop,
        setTop: (v) => {
          el.scrollTop = v;
        },
        getHeight: () => el.scrollHeight,
        getViewport: () => el.clientHeight,
      };
    }
    return {
      getTop: () => window.scrollY || docEl.scrollTop,
      setTop: (v) => {
        window.scrollTo({ top: v, behavior: 'instant' });
        docEl.scrollTop = v;
      },
      getHeight: () => docEl.scrollHeight,
      getViewport: () => window.innerHeight || docEl.clientHeight,
    };
  }

  function overlay(text) {
    document.getElementById('cb-scan-overlay')?.remove();
    const el = document.createElement('div');
    el.id = 'cb-scan-overlay';
    el.setAttribute('data-cb-skip', '');
    el.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:320px;padding:12px 14px;border-radius:10px;background:#111827;color:#f9fafb;font:13px/1.4 system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.28)';
    el.textContent = text;
    document.documentElement.appendChild(el);
    return {
      update: (t) => {
        el.textContent = t;
      },
      close: () => el.remove(),
    };
  }

  async function settle(scroller) {
    const before = scroller.getHeight();
    await sleep(420);
    if (scroller.getHeight() !== before) await sleep(420);
  }

  /** The messages currently rendered, in document order. */
  function renderedMessages() {
    const adapter = currentAdapter();
    let turns = adapter ? adapter.turns() : [];
    if (!turns.length) turns = outermost(genericTurns());
    return turnsToMessages(turns, adapter);
  }

  const sameMessage = (a, b) => a.role === b.role && a.content === b.content;

  /**
   * Stitch the messages rendered in the current scroll window onto the accumulated thread by
   * aligning the two sequences. Repeated identical messages ("continue", "yes"…) stay apart
   * because a match needs matching neighbours, not just matching text.
   */
  function mergeWindow(acc, cur) {
    if (!acc.length) return cur.slice();
    if (!cur.length) return acc;
    // cur overlaps the tail of acc (the usual case while scrolling down) or sits inside it
    for (let i = 0; i < acc.length; i += 1) {
      let j = 0;
      while (j < cur.length && i + j < acc.length && sameMessage(acc[i + j], cur[j])) j += 1;
      if (j > 0 && i + j === acc.length) return [...acc, ...cur.slice(j)];
      if (j === cur.length) return acc;
    }
    // cur overlaps the head of acc (older messages loaded above)
    for (let p = 1; p < cur.length; p += 1) {
      let j = 0;
      while (j < acc.length && p + j < cur.length && sameMessage(cur[p + j], acc[j])) j += 1;
      if (j > 0 && (p + j === cur.length || j === acc.length)) return [...cur.slice(0, p), ...acc, ...cur.slice(p + j)];
    }
    // no overlap at all (the window jumped): keep everything rather than lose messages
    return [...acc, ...cur];
  }

  async function deepScan() {
    const quick = extractConversation();
    if (!quick) return null;
    const scroller = findScroller();
    const originalTop = scroller.getTop();
    let collected = [];
    const ui = overlay('Full-thread capture running. The page will scroll while messages are collected.');
    try {
      let last = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 80 && scroller.getTop() < last; i += 1) {
        last = scroller.getTop();
        scroller.setTop(0);
        await settle(scroller);
        if (scroller.getTop() <= 2) break;
      }
      // Some threads keep loading older messages when the top is reached — nudge a few more times.
      for (let i = 0; i < 12; i += 1) {
        const h = scroller.getHeight();
        scroller.setTop(0);
        await settle(scroller);
        if (scroller.getHeight() === h) break;
      }
      let stalls = 0;
      let lastTarget = -1;
      for (let step = 0; step < 400 && stalls < 4; step += 1) {
        collected = mergeWindow(collected, renderedMessages());
        ui.update(`Full-thread capture running. Collected ${collected.length} messages so far.`);
        const viewport = Math.max(scroller.getViewport(), 600);
        const target = Math.min(scroller.getTop() + Math.floor(viewport * 0.45), scroller.getHeight() - viewport);
        if (target <= lastTarget + 4 || scroller.getTop() + viewport >= scroller.getHeight() - 4) stalls += 1;
        else stalls = 0;
        lastTarget = scroller.getTop();
        scroller.setTop(Math.max(0, target));
        await settle(scroller);
      }
      collected = mergeWindow(collected, renderedMessages());
    } finally {
      scroller.setTop(originalTop);
      ui.close();
    }
    // Positional ids were computed per scroll window; recompute them against the merged thread.
    const messages = collected.map((m, i) => publicMessage({ ...m, index: i, id: m.stableId ? m.id : positionalId(i, m.role, m.content) }));
    // If scrolling produced fewer messages than were visible to begin with, the scan cannot be
    // trusted: return the visible capture and say so instead of labelling it "full".
    if (messages.length < quick.messages.length) return { ...quick, captureLevel: 'quick', partial: true };
    return { ...quick, messages, captureLevel: 'full', updatedAt: new Date().toISOString() };
  }

  // ------------------------------------------------------------------
  // composer insertion (hand-off to another assistant)
  // ------------------------------------------------------------------

  function composerSelectors() {
    const h = location.hostname;
    if (h === 'chatgpt.com' || h === 'chat.openai.com') {
      return ['#prompt-textarea', "div.ProseMirror[contenteditable='true']", "[data-lexical-editor='true'][contenteditable='true']", "textarea[placeholder*='Message' i]"];
    }
    if (h === 'claude.ai') return ["[data-testid='chat-input'] [contenteditable='true']", "div.ProseMirror[contenteditable='true']", "[contenteditable='true'][data-placeholder]", 'fieldset [contenteditable="true"]'];
    if (h === 'gemini.google.com') return ["rich-textarea [contenteditable='true']", ".ql-editor[contenteditable='true']", "[contenteditable='true'][aria-label*='prompt' i]"];
    return ["textarea[placeholder*='Ask' i]", "[contenteditable='true'][role='textbox']", 'textarea'];
  }

  function findComposer() {
    const specific = composerSelectors().flatMap((s) => Array.from(document.querySelectorAll(s)));
    const generic = Array.from(document.querySelectorAll("textarea, [contenteditable='true'][role='textbox'], [contenteditable='true'][aria-multiline='true'], div.ProseMirror[contenteditable='true']"));
    return (
      [...specific, ...generic].find((el) => {
        if (!isVisible(el)) return false;
        if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
        return el.isContentEditable;
      }) ?? null
    );
  }

  function fireInput(el, text) {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function insertText(el, text) {
    el.focus();
    // Whatever the user already typed stays: the text is appended after it, never replaces it.
    if (el instanceof HTMLTextAreaElement) {
      const existing = el.value;
      const next = existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n${text}` : text;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(el, next);
      else el.value = next;
      fireInput(el, text);
      return true;
    }
    const hadDraft = (el.textContent ?? '').trim().length > 0;
    placeCaretAtEnd(el);
    const payload = hadDraft ? `\n\n${text}` : text;
    // 1) synthetic paste — the most faithful path for ProseMirror/Lexical/Quill editors
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', payload);
      const pasted = el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (!pasted && (el.textContent ?? '').includes(text.slice(0, 60))) return true;
    } catch {
      /* fall through */
    }
    // 2) execCommand keeps undo history and triggers editor listeners
    try {
      placeCaretAtEnd(el);
      document.execCommand('insertText', false, payload);
    } catch {
      /* fall through */
    }
    if ((el.textContent ?? '').includes(text.slice(0, 60))) {
      fireInput(el, text);
      return true;
    }
    // 3) last resort: append paragraphs directly
    text.split('\n').forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      el.appendChild(p);
    });
    fireInput(el, text);
    return true;
  }

  function placeCaretAtEnd(el) {
    try {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* editors without a selectable body */
    }
  }

  function sendButtonSelectors() {
    const h = location.hostname;
    if (h === 'chatgpt.com' || h === 'chat.openai.com') return ["button[data-testid='send-button']", "button[aria-label*='Send prompt' i]"];
    if (h === 'claude.ai') return ["button[aria-label*='Send message' i]", "button[data-testid*='send' i]"];
    if (h === 'gemini.google.com') return ["button[aria-label*='Send' i]", '.send-button', "button[data-test-id*='send' i]"];
    return ["button[aria-label='Submit']", "button[aria-label*='submit' i]", "button[aria-label*='send' i]"];
  }

  function findSendButton() {
    const specific = sendButtonSelectors().flatMap((s) => Array.from(document.querySelectorAll(s)));
    const generic = Array.from(document.querySelectorAll("button[aria-label*='send' i], button[title*='send' i], button[type='submit']"));
    return (
      [...specific, ...generic].find(
        (b) => b instanceof HTMLButtonElement && isVisible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true',
      ) ?? null
    );
  }

  async function insertIntoComposer(text, autoSend) {
    const composer = findComposer();
    if (!composer) return { ok: false, error: 'The destination composer is still loading.' };
    insertText(composer, text);
    if (!autoSend) return { ok: true, data: { sent: false } };
    for (let i = 0; i < 15; i += 1) {
      await sleep(200);
      const btn = findSendButton();
      if (btn) {
        btn.click();
        return { ok: true, data: { sent: true } };
      }
    }
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return { ok: true, data: { sent: false } };
  }

  // ------------------------------------------------------------------
  // navigation + live sync notifications
  // ------------------------------------------------------------------

  let lastUrl = location.href;
  let liveSyncEnabled = false;
  let syncTimer = null;
  let observer = null;
  let urlTimer = null;

  // After the extension is updated or reloaded this copy of the script is orphaned: its
  // chrome.runtime is gone. Stop the timers and observers instead of erroring every second.
  function orphaned() {
    if (chrome?.runtime?.id) return false;
    clearInterval(urlTimer);
    clearTimeout(syncTimer);
    observer?.disconnect();
    observer = null;
    return true;
  }

  function notify(type, extra = {}) {
    if (orphaned()) return;
    try {
      chrome.runtime.sendMessage({ type, url: location.href, ...extra }).catch(() => {});
    } catch {
      /* extension context invalidated between the check and the call */
    }
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => notify('PAGE_CONTENT_CHANGED'), 2500);
  }

  function setLiveSync(enabled) {
    liveSyncEnabled = Boolean(enabled);
    observer?.disconnect();
    observer = null;
    if (!liveSyncEnabled) return;
    observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  urlTimer = setInterval(() => {
    if (orphaned()) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      notify('PAGE_NAVIGATED');
    }
  }, 1000);
  window.addEventListener('popstate', () => notify('PAGE_NAVIGATED'));

  // ------------------------------------------------------------------
  // message handling
  // ------------------------------------------------------------------

  // Debug hook (isolated world only — page scripts cannot see it). Handy for support:
  // run `__conversationBridge.extract()` in the extension's content-script console context.
  window.__conversationBridge = { extract: extractConversation, deepScan, toMarkdown: elementToMarkdown, adapters, turnsToMessages, mergeWindow, findComposer, findSendButton };

  const runtime = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
  if (!runtime?.onMessage) return;

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'PING':
        sendResponse({ ok: true, data: { platform: currentAdapter()?.id ?? 'other', url: location.href } });
        return false;
      case 'EXTRACT_CONVERSATION': {
        const run = message.mode === 'deep' ? deepScan() : Promise.resolve(extractConversation());
        run
          .then((conv) => sendResponse(conv ? { ok: true, data: conv } : { ok: false, error: 'No conversation messages were found on this page yet. Start or open a chat, then try again.' }))
          .catch((err) => sendResponse({ ok: false, error: err?.message ?? 'Extraction failed.' }));
        return true;
      }
      case 'INSERT_TRANSFER_CONTEXT':
        insertIntoComposer(String(message.text ?? ''), message.autoSend !== false).then(sendResponse);
        return true;
      case 'SET_LIVE_SYNC':
        setLiveSync(message.enabled);
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  try {
    chrome.runtime
      .sendMessage({ type: 'CONTENT_SCRIPT_READY', url: location.href })
      .then((res) => setLiveSync(Boolean(res?.data?.liveSync)))
      .catch(() => {});
  } catch {
    /* ignore */
  }
})();
