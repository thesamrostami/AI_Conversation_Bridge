// Local keyword scoring: auto-topics, related conversations and context packets.
// Everything runs in the browser; nothing leaves the machine.

import { platformLabel } from './util.js';

const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by can could
   did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into
   is it its itself just like me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she
   should so some such than that the their theirs them themselves then there these they this those through to too under until up use using
   very want was we were what when where which while who whom why will with would you your yours yourself yourselves
   thanks thank please hello help make need something things thing really actually maybe sure okay ok yes well know think going get got
   let lets one two three first second also however therefore example example. etc however still even much many way ways good great
   code data file files line lines question answer model response user assistant chatgpt claude gemini perplexity`
    .split(/\s+/)
    .filter(Boolean),
);

// Any Unicode letter/number run (Latin, Persian, Arabic, Cyrillic, CJK…), keeping +#.- inside words (c++, c#, node.js).
const WORD = /[\p{L}\p{N}][\p{L}\p{N}+#.\-]*/gu;
// Scripts written without spaces are split into character bigrams so they still yield comparable terms.
const UNSEGMENTED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}]+/gu;

export function tokenize(text) {
  const src = String(text ?? '')
    .toLowerCase()
    .replace(UNSEGMENTED, (run) => ` ${run} `);
  const out = [];
  for (const raw of src.match(WORD) ?? []) {
    const t = raw.replace(/^[.-]+|[.-]+$/g, '');
    if (!t || STOPWORDS.has(t) || /^\p{N}+$/u.test(t)) continue;
    if (UNSEGMENTED.test(t)) {
      UNSEGMENTED.lastIndex = 0;
      if (t.length <= 2) out.push(t);
      else for (let i = 0; i + 1 < t.length; i += 1) out.push(t.slice(i, i + 2));
      continue;
    }
    UNSEGMENTED.lastIndex = 0;
    if (t.length > 2) out.push(t);
  }
  return out;
}

function termVector(conv) {
  const vec = new Map();
  const add = (text, weight) => {
    for (const term of tokenize(text)) vec.set(term, Math.min((vec.get(term) ?? 0) + weight, 8));
  };
  add(conv.title, 4);
  (conv.tags ?? []).forEach((t) => add(t, 5));
  (conv.autoTags ?? []).forEach((t) => add(t, 3));
  const msgs = conv.messages ?? [];
  [...msgs.slice(0, 3), ...msgs.slice(-5)].forEach((m) => add(String(m.content ?? '').slice(0, 1500), m.role === 'user' ? 1.5 : 1));
  return vec;
}

export function autoTagsFor(conv, limit = 5) {
  const vec = termVector({ ...conv, autoTags: [] });
  const manual = new Set((conv.tags ?? []).map((t) => t.toLowerCase()));
  return [...vec.entries()]
    .filter(([term]) => !manual.has(term))
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([term]) => term);
}

function norm(vec) {
  return Math.sqrt([...vec.values()].reduce((sum, v) => sum + v * v, 0));
}

/** Related conversations by cosine similarity over weighted keywords. Works with metadata only. */
export function relatedConversations(target, candidates, limit = 5) {
  const tv = termVector(target);
  const tn = norm(tv);
  if (!tn) return [];
  return candidates
    .filter((c) => c.id !== target.id)
    .map((c) => {
      const cv = termVector(c);
      const cn = norm(cv);
      const shared = [...tv.keys()]
        .filter((k) => cv.has(k))
        .sort((a, b) => (tv.get(b) ?? 0) + (cv.get(b) ?? 0) - ((tv.get(a) ?? 0) + (cv.get(a) ?? 0)))
        .slice(0, 4);
      const dot = shared.reduce((sum, k) => sum + (tv.get(k) ?? 0) * (cv.get(k) ?? 0), 0);
      return { conversation: c, score: cn ? dot / (tn * cn) : 0, sharedTerms: shared };
    })
    .filter((r) => r.sharedTerms.length >= 2 && r.score >= 0.07)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------- context packets ----------

function header(conv) {
  const lines = [`Platform: ${platformLabel(conv.platform)}`];
  if (conv.tags?.length) lines.push(`Tags: ${conv.tags.join(', ')}`);
  if (conv.autoTags?.length) lines.push(`Topics: ${conv.autoTags.join(', ')}`);
  if (conv.notes) lines.push(`Notes: ${conv.notes}`);
  return [`## ${conv.title}`, '', ...lines, ''].join('\n');
}

function overview(conv) {
  return header(conv);
}

function working(conv) {
  const msgs = conv.messages ?? [];
  const picked = [...msgs.slice(0, 2), ...msgs.slice(-4)].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);
  const body = picked.map((m) => `### ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.content}`).join('\n\n');
  return `${header(conv)}${body}\n`;
}

function full(conv) {
  const msgs = conv.messages ?? [];
  const body = msgs.map((m) => `### ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.content}`).join('\n\n');
  return `${header(conv)}${body}\n`;
}

/**
 * Build a Markdown "context packet" from several conversations.
 * level: overview (titles + notes) | working (first/last messages) | full (everything)
 */
export function buildContextPacket(workspace, conversations, level = 'working', { instruction } = {}) {
  const title = workspace?.title ?? 'Connected conversations';
  const goal = workspace?.goal ? `\n\nGoal: ${workspace.goal}` : '';
  const intro = `# ${title}${goal}\n\nThis packet was prepared locally with Conversation Bridge. Use it as shared context, then continue with the next useful step.\n`;
  const render = level === 'overview' ? overview : level === 'full' ? full : working;
  const body = conversations.map(render).join('\n\n---\n\n');
  const tail = instruction ? `\n\n---\n\n${instruction}\n` : '';
  return `${intro}\n---\n\n${body}${tail}`;
}
