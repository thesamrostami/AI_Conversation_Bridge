// Workflows view: group related chats, build context packets, hand them to another assistant.

import { h, button, select, empty, toast, confirm, prompt, copyText } from '../dom.js';
import * as store from '../../lib/storage.js';
import { buildContextPacket, relatedConversations } from '../../lib/similarity.js';
import { PLATFORMS, platformLabel, STAGES, plural, slugify } from '../../lib/util.js';
import { downloadText } from '../actions.js';
import { renderTransfer } from './capture.js';

const LEVELS = [
  ['overview', 'Overview — titles, tags, notes'],
  ['working', 'Working — first & last messages'],
  ['full', 'Full — every message'],
];

export function renderWorkflows(ctx) {
  const { state } = ctx;
  const wf = state.workflow;
  const workspace = state.workspaces.find((w) => w.id === wf.workspaceId) ?? null;
  const members = (workspace ? state.index.filter((m) => m.workspaceId === workspace.id) : state.index).filter((m) => wf.stage === 'all' || m.workflowStage === wf.stage);
  wf.selected = new Set([...wf.selected].filter((id) => state.index.some((m) => m.id === id)));
  const selectedMetas = state.index.filter((m) => wf.selected.has(m.id));

  const header = h(
    'div',
    { class: 'row between' },
    h('div', {}, h('h2', { class: 'title' }, 'Workflows'), h('p', { class: 'small muted', style: { margin: 0 } }, 'Group related chats and carry shared context between assistants.')),
    button({ iconName: 'plus', className: 'btn icon', title: 'New workflow', onClick: () => createWorkspace(ctx) }),
  );

  const picker = select({
    value: wf.workspaceId,
    ariaLabel: 'Workflow',
    options: [['', 'All saved conversations'], ...state.workspaces.map((w) => [w.id, w.title])],
    onChange: (v) => {
      wf.workspaceId = v;
      wf.selected = new Set();
      ctx.render();
    },
  });

  const editor = workspace ? renderWorkspaceEditor(ctx, workspace) : null;

  const addCurrent =
    workspace && state.current?.conv && state.current.savedMeta && state.current.savedMeta.workspaceId !== workspace.id
      ? button({
          label: 'Add the current chat to this workflow',
          iconName: 'plus',
          className: 'btn block',
          onClick: async () => {
            await store.updateConversation(state.current.savedMeta.id, { workspaceId: workspace.id, workflowStage: 'active' });
            await ctx.reload();
            ctx.render();
            toast(`Added to ${workspace.title}`);
          },
        })
      : null;

  const toolbar = h(
    'div',
    { class: 'row between wrap' },
    select({ value: wf.stage, className: 'select sm', ariaLabel: 'Stage filter', options: [['all', 'Every stage'], ...Object.entries(STAGES)], onChange: (v) => ((wf.stage = v), ctx.render()) }),
    h(
      'div',
      { class: 'row', style: { gap: '2px' } },
      h('button', { class: 'text-btn muted', onClick: () => ((wf.selected = new Set(members.map((m) => m.id))), ctx.render()) }, 'Select shown'),
      h('button', { class: 'text-btn muted', onClick: () => ((wf.selected = new Set()), ctx.render()) }, 'Clear'),
    ),
  );

  const packet = renderPacket(ctx, workspace, selectedMetas);

  const rows = members.map((m) => renderRow(ctx, m, workspace));
  const list = rows.length
    ? h('div', { class: 'stack' }, ...rows)
    : empty({
        iconName: 'layers',
        title: workspace ? 'No chats in this workflow yet' : 'No saved chats yet',
        text: workspace ? 'Open a saved chat and pick this workflow, or select chats in the Library and use "Add to workflow".' : 'Save a conversation from the Capture tab first.',
      });

  const focus = state.index.find((m) => m.id === wf.focusId);
  const related = focus ? renderRelated(ctx, focus, workspace) : null;

  return h('div', { class: 'stack fade', style: { gap: '12px' } }, header, picker, editor, addCurrent, toolbar, packet, list, related);
}

async function createWorkspace(ctx) {
  const { state } = ctx;
  const title = await prompt({ title: 'New workflow', text: 'Name the project or question this workflow is about.', placeholder: 'e.g. Thesis literature review', confirmLabel: 'Create' });
  if (title === null) return;
  const ws = await store.saveWorkspace({ title: title.trim() || 'Untitled workflow', goal: '' });
  state.workflow.workspaceId = ws.id;
  state.workflow.selected = new Set();
  await ctx.reload();
  ctx.render();
  toast('Workflow created');
}

function renderWorkspaceEditor(ctx, workspace) {
  const title = h('input', { class: 'input', value: workspace.title, 'aria-label': 'Workflow title', placeholder: 'Workflow title' });
  const goal = h('textarea', { class: 'textarea', value: workspace.goal ?? '', placeholder: 'Goal — what should the next assistant help you achieve?', 'aria-label': 'Workflow goal' });
  const save = async () => {
    await store.saveWorkspace({ ...workspace, title: title.value.trim() || 'Untitled workflow', goal: goal.value });
    await ctx.reload();
    ctx.render();
    toast('Workflow saved');
  };
  title.addEventListener('change', save);
  goal.addEventListener('change', save);
  const del = button({
    iconName: 'trash',
    className: 'btn icon sm',
    title: 'Delete workflow (conversations stay in the library)',
    onClick: async () => {
      const ok = await confirm({ title: 'Delete workflow?', text: 'Conversations stay in your library; they just leave this group.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      await store.deleteWorkspace(workspace.id);
      ctx.state.workflow.workspaceId = '';
      await ctx.reload();
      ctx.render();
    },
  });
  return h('div', { class: 'panel stack' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, title), del), goal);
}

function renderPacket(ctx, workspace, selectedMetas) {
  const { state } = ctx;
  const wf = state.workflow;
  const template = state.templates.find((t) => t.id === wf.promptId);
  const build = async () => {
    if (!selectedMetas.length) {
      toast('Select conversations to include first', { type: 'error' });
      return null;
    }
    const convs = wf.level === 'overview' ? selectedMetas.map((m) => ({ ...m, messages: [] })) : await store.getConversations(selectedMetas.map((m) => m.id));
    return buildContextPacket(workspace, convs, wf.level, { instruction: template?.body });
  };
  const estimate = selectedMetas.reduce((sum, m) => sum + (wf.level === 'overview' ? 60 : wf.level === 'working' ? Math.min(m.chars ?? 0, 6000) : m.chars ?? 0), 0);
  const levelSelect = select({
    value: wf.level,
    className: 'select sm',
    ariaLabel: 'Packet detail level',
    options: LEVELS,
    onChange: (v) => {
      wf.level = v;
      ctx.render();
    },
  });
  const promptSelect = select({
    value: wf.promptId,
    className: 'select sm',
    ariaLabel: 'Instruction appended to the packet',
    options: [['', 'No instruction appended'], ...state.templates.map((t) => [t.id, `+ ${t.title}`])],
    onChange: (v) => ((wf.promptId = v), ctx.render()),
  });
  return h(
    'div',
    { class: 'panel stack' },
    h(
      'div',
      { class: 'row between' },
      h('div', {}, h('div', { class: 'section-label' }, 'Context packet'), h('div', { class: 'small muted' }, `${plural(selectedMetas.length, 'conversation')} selected · ~${Math.ceil(estimate / 3.8).toLocaleString()} tokens`)),
    ),
    h('div', { class: 'grid-2' }, levelSelect, promptSelect),
    h(
      'div',
      { class: 'grid-2' },
      button({
        label: 'Copy',
        iconName: 'copy',
        onClick: async () => {
          const text = await build();
          if (text) {
            await copyText(text);
            toast('Context packet copied');
          }
        },
      }),
      button({
        label: 'Download',
        iconName: 'download',
        onClick: async () => {
          const text = await build();
          if (!text) return;
          await downloadText(`${slugify(workspace?.title ?? 'connected-conversations')}-context.md`, text, 'text/markdown', state.settings);
          toast('Context packet downloaded');
        },
      }),
    ),
    renderTransfer(ctx, build, { label: 'Transfer packet' }),
  );
}

function renderRow(ctx, meta, workspace) {
  const { state } = ctx;
  const wf = state.workflow;
  const platform = PLATFORMS[meta.platform] ?? PLATFORMS.other;
  return h(
    'div',
    { class: `card flat conv-card ${wf.selected.has(meta.id) ? 'selected' : ''}`, style: { padding: '8px 10px' } },
    h('input', {
      type: 'checkbox',
      checked: wf.selected.has(meta.id),
      'aria-label': `Include ${meta.title} in the context packet`,
      onChange: (e) => {
        if (e.target.checked) wf.selected.add(meta.id);
        else wf.selected.delete(meta.id);
        ctx.render();
      },
    }),
    h(
      'div',
      { class: 'grow' },
      h('button', { class: 'title truncate', onClick: () => ctx.openReader(meta.id) }, meta.title),
      h(
        'div',
        { class: 'meta' },
        h('span', { class: 'row', style: { gap: '4px' } }, h('span', { class: 'platform-dot', style: { background: platform.color } }), platformLabel(meta.platform)),
        !workspace && meta.workspaceId ? h('span', { class: 'badge neutral' }, state.workspaces.find((w) => w.id === meta.workspaceId)?.title ?? 'Workflow') : null,
        h('span', {}, plural(meta.messageCount, 'msg')),
      ),
    ),
    h(
      'div',
      { class: 'side', style: { alignItems: 'stretch', gap: '4px' } },
      select({ value: meta.workflowStage ?? 'inbox', className: 'select sm', ariaLabel: 'Stage', options: Object.entries(STAGES), onChange: async (v) => (await store.updateConversation(meta.id, { workflowStage: v }), await ctx.reload(), ctx.render()) }),
      button({ iconName: 'link', className: `btn icon sm ${wf.focusId === meta.id ? 'active' : ''}`, title: 'Show related chats', onClick: () => ((wf.focusId = wf.focusId === meta.id ? '' : meta.id), ctx.render()) }),
    ),
  );
}

function renderRelated(ctx, focus, workspace) {
  const { state } = ctx;
  const related = relatedConversations(focus, state.index, 6);
  return h(
    'div',
    { class: 'panel stack' },
    h('div', { class: 'row between' }, h('div', {}, h('div', { class: 'section-label' }, 'Related chats'), h('div', { class: 'small muted truncate' }, `For "${focus.title}"`)), button({ iconName: 'x', className: 'btn icon sm', title: 'Close', onClick: () => ((state.workflow.focusId = ''), ctx.render()) })),
    related.length
      ? related.map(({ conversation: c, sharedTerms }) =>
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn ghost grow', style: { justifyContent: 'flex-start', textAlign: 'left', minWidth: 0 }, onClick: () => ctx.openReader(c.id) }, h('div', { style: { minWidth: 0 } }, h('div', { class: 'truncate' }, c.title), h('div', { class: 'tiny muted truncate' }, sharedTerms.join(', ')))),
            workspace && c.workspaceId !== workspace.id
              ? button({ iconName: 'plus', className: 'btn icon sm', title: `Add to ${workspace.title}`, onClick: async () => (await store.updateConversation(c.id, { workspaceId: workspace.id, workflowStage: 'active' }), await ctx.reload(), ctx.render()) })
              : null,
          ),
        )
      : h('p', { class: 'small muted', style: { margin: 0 } }, 'No strong topic overlap yet. Saving a few focused chats makes this smarter.'),
  );
}
