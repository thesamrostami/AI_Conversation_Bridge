// Demo library used by panel-dev.html?seed=demo and tools/make-marketing.py.
// Populates the mocked chrome.storage.local with a realistic set of saved chats,
// a workflow and a custom prompt so every view has something to show.

import * as store from '../../src/lib/storage.js';

const daysAgo = (d, h = 0) => new Date(Date.now() - (d * 24 + h) * 3600000).toISOString();

export const DEMO_WORKSPACE = { id: 'workspace_api', title: 'API platform redesign', goal: 'Decide on rate limiting and event storage for the v2 public API before the design review.' };

export const DEMO_CONVERSATIONS = [
  {
    // no id: derived from the URL, so the Capture view's mocked "current chat" shows as Saved
    title: 'Designing a rate limiter for a public API',
    platform: 'chatgpt',
    url: 'https://chatgpt.com/c/demo-123',
    createdAt: daysAgo(0, 3),
    updatedAt: daysAgo(0, 1),
    captureLevel: 'full',
    tags: ['architecture', 'api'],
    notes: 'Go with token bucket + Lua script. Ask Claude about multi-region.',
    favorite: true,
    workspaceId: DEMO_WORKSPACE.id,
    workflowStage: 'active',
    messages: [
      { id: 'm1', role: 'user', content: 'How should I design a **token bucket** rate limiter for a public API with ~10k req/s?' },
      {
        id: 'm2',
        role: 'assistant',
        content:
          'Here is a compact design:\n\n1. Keep a bucket per API key in Redis\n2. Refill lazily on each request\n3. Reject with `429` when empty\n\n```python\ndef allow(key, rate, burst):\n    now = time.time()\n    tokens, last = redis.hmget(key, "t", "ts")\n    tokens = min(burst, tokens + (now - last) * rate)\n    if tokens < 1:\n        return False\n    redis.hmset(key, {"t": tokens - 1, "ts": now})\n    return True\n```\n\n| Option | Pros | Cons |\n| --- | --- | --- |\n| Token bucket | Bursty-friendly | Needs state |\n| Sliding window | Precise | More memory |\n\n> Tip: use a Lua script so the read-modify-write is atomic.',
      },
      { id: 'm3', role: 'user', content: 'What about distributed consistency across regions?' },
      { id: 'm4', role: 'assistant', content: 'Use **local buckets** with periodic reconciliation, or accept eventual consistency. Route each API key to a home region and let other regions enforce a slightly looser limit. See [this paper](https://example.com/paper) for the trade-offs.' },
    ],
  },
  {
    id: 'conv_eventstore',
    title: 'Postgres vs DynamoDB for an event store',
    platform: 'claude',
    url: 'https://claude.ai/chat/demo-456',
    createdAt: daysAgo(1, 5),
    updatedAt: daysAgo(1, 2),
    captureLevel: 'quick',
    tags: ['architecture', 'databases'],
    notes: '',
    workspaceId: DEMO_WORKSPACE.id,
    workflowStage: 'review',
    messages: [
      { id: 'e1', role: 'user', content: 'We append ~2k events/s and replay streams per aggregate. Postgres or DynamoDB?' },
      { id: 'e2', role: 'assistant', content: 'Both work at that scale; the deciding factors are **query shape** and **ops**.\n\n- Postgres: one `events(stream_id, version, payload)` table with a `(stream_id, version)` primary key gives you optimistic concurrency for free.\n- DynamoDB: partition on `stream_id`, sort on `version`; use a conditional put for the same guarantee.\n\nIf you already run Postgres, stay there until a single stream exceeds a few million events.' },
      { id: 'e3', role: 'user', content: 'How would snapshots fit in?' },
      { id: 'e4', role: 'assistant', content: 'Store a snapshot every N events in a sibling table keyed by `(stream_id, version)`. On replay, load the latest snapshot and only the events after it. Keep snapshots disposable — they are a cache, not the source of truth.' },
    ],
  },
  {
    id: 'conv_transformers',
    title: 'Literature review: efficient transformer papers',
    platform: 'gemini',
    url: 'https://gemini.google.com/app/demo-789',
    createdAt: daysAgo(3),
    updatedAt: daysAgo(2, 6),
    captureLevel: 'full',
    tags: ['research', 'ml'],
    notes: 'Candidates for the related-work section.',
    pinned: true,
    workflowStage: 'inbox',
    messages: [
      { id: 't1', role: 'user', content: 'Summarise the main approaches to reducing attention cost in transformers, with representative papers.' },
      { id: 't2', role: 'assistant', content: 'Four families dominate:\n\n1. **Sparse attention** — Longformer, BigBird\n2. **Low-rank / kernel approximations** — Linformer, Performer\n3. **Recurrence and memory** — Transformer-XL, Compressive Transformer\n4. **Hardware-aware exact attention** — FlashAttention\n\nFor most practical work, FlashAttention gives the biggest win with no accuracy trade-off.' },
      { id: 't3', role: 'user', content: 'Which of these are still relevant in 2026?' },
      { id: 't4', role: 'assistant', content: 'Exact, hardware-aware kernels have largely won for dense models; sparse and linear variants survive in very long-context and on-device settings. Cite FlashAttention-2/3 as the baseline and one sparse method for contrast.' },
    ],
  },
  {
    id: 'conv_reactform',
    title: 'Refactoring a React form with useReducer',
    platform: 'chatgpt',
    url: 'https://chatgpt.com/c/demo-321',
    createdAt: daysAgo(5),
    updatedAt: daysAgo(4, 3),
    captureLevel: 'quick',
    tags: ['react', 'frontend'],
    notes: '',
    workflowStage: 'done',
    messages: [
      { id: 'r1', role: 'user', content: 'My form has 12 `useState` hooks and it is getting messy. How would you restructure it?' },
      { id: 'r2', role: 'assistant', content: 'Collapse the fields into one `useReducer` with typed actions:\n\n```ts\ntype Action =\n  | { type: "change"; field: keyof Form; value: string }\n  | { type: "reset" };\n\nfunction reducer(state: Form, action: Action): Form {\n  switch (action.type) {\n    case "change":\n      return { ...state, [action.field]: action.value };\n    case "reset":\n      return initial;\n  }\n}\n```\n\nValidation becomes a pure function of `state`, which is much easier to test.' },
    ],
  },
  {
    id: 'conv_onboarding',
    title: 'Product spec for the onboarding email sequence',
    platform: 'perplexity',
    url: 'https://www.perplexity.ai/search/demo-654',
    createdAt: daysAgo(8),
    updatedAt: daysAgo(7, 1),
    captureLevel: 'quick',
    tags: ['product', 'writing'],
    notes: 'Shared with marketing.',
    favorite: true,
    workflowStage: 'done',
    messages: [
      { id: 'o1', role: 'user', content: 'Draft a 5-email onboarding sequence for a B2B analytics tool. Goal: first dashboard created within 7 days.' },
      { id: 'o2', role: 'assistant', content: '**Day 0 — Welcome:** one action, connect a data source.\n**Day 1 — First win:** template gallery, 3-minute video.\n**Day 3 — Nudge:** "your data is ready" with a pre-built dashboard.\n**Day 5 — Social proof:** a customer story matching their industry.\n**Day 7 — Check-in:** offer a 15-minute call if no dashboard exists yet.\n\nTrack *time-to-first-dashboard* as the north-star metric for the sequence.' },
    ],
  },
  {
    id: 'conv_rust',
    title: 'Explain Rust ownership with examples',
    platform: 'claude',
    url: 'https://claude.ai/chat/demo-987',
    createdAt: daysAgo(12),
    updatedAt: daysAgo(11),
    captureLevel: 'quick',
    tags: ['rust', 'learning'],
    notes: '',
    workflowStage: 'inbox',
    messages: [
      { id: 'u1', role: 'user', content: 'I keep hitting "value borrowed after move". Explain ownership like I know Python.' },
      { id: 'u2', role: 'assistant', content: 'In Python every variable is a reference and the GC cleans up. In Rust each value has exactly **one owner**; assigning it *moves* ownership:\n\n```rust\nlet a = String::from("hi");\nlet b = a;        // a is moved into b\nprintln!("{a}"); // error: borrow of moved value\n```\n\nBorrow instead when you only need to read: `let b = &a;`. The compiler is enforcing at build time what Python\'s GC does at run time.' },
    ],
  },
];

export async function seedDemo() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('cb.'));
  if (keys.length) await chrome.storage.local.remove(keys);
  await store.saveWorkspace(DEMO_WORKSPACE);
  // oldest first so the index ends up in the same order the UI would produce
  const stamps = new Map();
  for (const conv of [...DEMO_CONVERSATIONS].reverse()) {
    const meta = await store.saveConversation(conv, { preserveUserFields: false });
    stamps.set(meta.id, conv);
  }
  // saveConversation stamps "now"; restore the demo timestamps so relative times vary
  const { [store.KEYS.index]: index } = await chrome.storage.local.get(store.KEYS.index);
  await chrome.storage.local.set({
    [store.KEYS.index]: index.map((m) => {
      const c = stamps.get(m.id);
      return c ? { ...m, createdAt: c.createdAt, updatedAt: c.updatedAt, savedAt: c.updatedAt } : m;
    }),
  });
  await store.listTemplates();
  await store.saveTemplate({ id: 'template_demo_adr', title: 'Write an ADR', body: 'Turn the decision in this conversation into an Architecture Decision Record: context, decision, consequences, alternatives considered.' });
  await store.updateSettings({ frontmatter: true, liveSync: true });
}
