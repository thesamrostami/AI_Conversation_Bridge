// Prompts view: reusable instructions appended to exports, packets and transfers.

import { h, button, toast, confirm, copyText } from '../dom.js';
import * as store from '../../lib/storage.js';
import { plural } from '../../lib/util.js';
import { sendMessage } from '../actions.js';

export function renderPrompts(ctx) {
  const { state } = ctx;
  const custom = state.templates.filter((t) => !t.builtIn);
  const header = h(
    'div',
    { class: 'row between' },
    h('div', {}, h('h2', { class: 'title' }, 'Prompts'), h('p', { class: 'small muted', style: { margin: 0 } }, 'Append an instruction when you copy, export or transfer a chat.')),
    button({
      iconName: 'plus',
      className: 'btn icon',
      title: 'New prompt',
      onClick: async () => {
        const t = await store.saveTemplate({ title: 'New prompt', body: 'Use this conversation as context and respond with clear, practical next steps.' });
        await ctx.reload();
        ctx.render();
        setTimeout(() => document.getElementById(`tpl-title-${t.id}`)?.select(), 30);
      },
    }),
  );
  const cards = state.templates.map((t) => renderTemplate(ctx, t));
  const footer = h(
    'div',
    { class: 'row between small muted' },
    h('span', {}, plural(custom.length, 'custom prompt')),
    h(
      'button',
      {
        class: 'text-btn muted',
        onClick: async () => {
          const ok = await confirm({ title: 'Reset built-in prompts?', text: 'Custom prompts are removed and the default set is restored.', confirmLabel: 'Reset', danger: true });
          if (!ok) return;
          await store.resetTemplates();
          await ctx.reload();
          ctx.render();
        },
      },
      'Reset to defaults',
    ),
  );
  return h('div', { class: 'stack fade', style: { gap: '10px' } }, header, ...cards, footer);
}

function renderTemplate(ctx, t) {
  const title = h('input', { id: `tpl-title-${t.id}`, class: 'input', value: t.title, 'aria-label': 'Prompt title', placeholder: 'Title' });
  const body = h('textarea', { class: 'textarea', value: t.body, rows: 3, 'aria-label': 'Prompt text', placeholder: 'Instruction text' });
  const save = async () => {
    if (title.value === t.title && body.value === t.body) return;
    await store.saveTemplate({ ...t, title: title.value.trim() || 'Untitled prompt', body: body.value });
    await ctx.reload();
    toast('Prompt saved');
  };
  title.addEventListener('change', save);
  body.addEventListener('change', save);
  return h(
    'div',
    { class: 'card stack' },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, title), t.builtIn ? h('span', { class: 'badge neutral', title: 'Built-in prompt (editable)' }, 'Built-in') : null),
    body,
    h(
      'div',
      { class: 'row between' },
      h(
        'div',
        { class: 'row', style: { gap: '4px' } },
        button({ label: 'Copy', iconName: 'copy', className: 'btn sm', onClick: async () => (await copyText(body.value), toast('Prompt copied')) }),
        button({
          label: 'Insert into chat',
          iconName: 'send',
          className: 'btn sm',
          title: 'Paste this prompt into the composer of the active chat tab',
          onClick: async () => {
            const res = await sendMessage({ type: 'INSERT_INTO_ACTIVE_TAB', text: body.value, autoSend: false });
            toast(res.ok ? 'Inserted — press Send in the chat' : res.error, { type: res.ok ? 'info' : 'error' });
          },
        }),
      ),
      button({
        iconName: 'trash',
        className: 'btn icon sm',
        title: 'Delete prompt',
        onClick: async () => {
          await store.deleteTemplate(t.id);
          await ctx.reload();
          ctx.render();
          toast('Prompt deleted', {
            action: {
              label: 'Undo',
              onClick: async () => {
                await store.saveTemplate(t);
                await ctx.reload();
                ctx.render();
              },
            },
          });
        },
      }),
    ),
  );
}

