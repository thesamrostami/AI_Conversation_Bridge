// Importers for official data exports (ChatGPT "conversations.json", Claude "conversations.json")
// and for Conversation Bridge backups / library exports.

import { uid } from './util.js';

function isoFromUnix(sec) {
  if (!sec) return new Date().toISOString();
  const ms = sec > 1e12 ? sec : sec * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// ---------- ChatGPT ----------

function chatgptMessageText(message) {
  const c = message?.content;
  if (!c) return '';
  if (typeof c.text === 'string') return c.content_type === 'code' ? `\`\`\`\n${c.text}\n\`\`\`` : c.text;
  if (Array.isArray(c.parts)) {
    return c.parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.content_type === 'image_asset_pointer') return '![image](image)';
        if (p?.text) return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function chatgptLinearMessages(conv) {
  const mapping = conv.mapping ?? {};
  let nodeId = conv.current_node;
  // fall back to the deepest leaf if current_node is missing
  if (!nodeId || !mapping[nodeId]) {
    const leaves = Object.values(mapping).filter((n) => !n.children?.length);
    nodeId = leaves.sort((a, b) => (b.message?.create_time ?? 0) - (a.message?.create_time ?? 0))[0]?.id;
  }
  const chain = [];
  const seen = new Set();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  chain.reverse();
  const messages = [];
  for (const node of chain) {
    const m = node.message;
    if (!m) continue;
    const role = m.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    const text = chatgptMessageText(m).trim();
    if (!text) continue;
    messages.push({ id: m.id || uid('msg'), role, content: text, timestamp: m.create_time ? isoFromUnix(m.create_time) : undefined });
  }
  return messages;
}

export function isChatgptExport(data) {
  return Array.isArray(data) && data.length > 0 && data.every((c) => c && typeof c === 'object' && 'mapping' in c);
}

export function importChatgptExport(data) {
  return data
    .map((conv) => {
      const messages = chatgptLinearMessages(conv);
      if (!messages.length) return null;
      const id = conv.conversation_id || conv.id;
      return {
        title: conv.title || messages[0].content.slice(0, 80) || 'Untitled conversation',
        platform: 'chatgpt',
        url: id ? `https://chatgpt.com/c/${id}` : '',
        createdAt: isoFromUnix(conv.create_time),
        updatedAt: isoFromUnix(conv.update_time ?? conv.create_time),
        messages,
        captureLevel: 'full',
        tags: [],
        notes: '',
      };
    })
    .filter(Boolean);
}

// ---------- Claude ----------

function claudeMessageText(m) {
  if (Array.isArray(m.content) && m.content.length) {
    return m.content
      .map((part) => {
        if (part?.type === 'text') return part.text ?? '';
        if (part?.type === 'tool_use' || part?.type === 'tool_result') return '';
        return part?.text ?? '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return m.text ?? '';
}

export function isClaudeExport(data) {
  return Array.isArray(data) && data.length > 0 && data.every((c) => c && typeof c === 'object' && Array.isArray(c.chat_messages));
}

export function importClaudeExport(data) {
  return data
    .map((conv) => {
      const messages = (conv.chat_messages ?? [])
        .map((m) => {
          const text = claudeMessageText(m).trim();
          if (!text) return null;
          return { id: m.uuid || uid('msg'), role: m.sender === 'human' ? 'user' : 'assistant', content: text, timestamp: m.created_at };
        })
        .filter(Boolean);
      if (!messages.length) return null;
      return {
        title: conv.name || messages[0].content.slice(0, 80) || 'Untitled conversation',
        platform: 'claude',
        url: conv.uuid ? `https://claude.ai/chat/${conv.uuid}` : '',
        createdAt: conv.created_at || new Date().toISOString(),
        updatedAt: conv.updated_at || conv.created_at || new Date().toISOString(),
        messages,
        captureLevel: 'full',
        tags: [],
        notes: '',
      };
    })
    .filter(Boolean);
}

// ---------- detection ----------

export function isBridgeBackup(data) {
  if (Array.isArray(data)) return data.every((c) => c && Array.isArray(c.messages));
  return Boolean(data && typeof data === 'object' && Array.isArray(data.conversations));
}

/**
 * Inspect parsed JSON and return { kind, conversations, backup } where kind is
 * 'chatgpt' | 'claude' | 'bridge' | 'unknown'.
 */
export function detectImport(data) {
  if (isChatgptExport(data)) return { kind: 'chatgpt', conversations: importChatgptExport(data) };
  if (isClaudeExport(data)) return { kind: 'claude', conversations: importClaudeExport(data) };
  if (isBridgeBackup(data)) return { kind: 'bridge', conversations: Array.isArray(data) ? data : data.conversations, backup: Array.isArray(data) ? null : data };
  return { kind: 'unknown', conversations: [] };
}
