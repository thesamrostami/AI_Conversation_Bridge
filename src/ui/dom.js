// Tiny DOM helpers: element builder, toasts, modals.

import { icon } from './icons.js';

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      // ARIA states are tri-state strings: aria-selected="false" is meaningful, "" is not.
      if (key.startsWith('aria-')) {
        el.setAttribute(key, String(value));
        continue;
      }
      if (value === false) continue;
      if (key === 'class' || key === 'className') el.className = value;
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in el && key !== 'list' && key !== 'form' && typeof value !== 'string') el[key] = value;
      else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected' || key === 'open') el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function frag(...children) {
  return append(document.createDocumentFragment(), children);
}

export function button({ label, iconName, className = 'btn', title, onClick, disabled, type = 'button', id }) {
  const el = h('button', { class: className, title: title ?? (label ? undefined : iconName), onClick, disabled, type, id, 'aria-label': label ?? title });
  if (iconName) el.append(icon(iconName));
  if (label) el.append(h('span', {}, label));
  return el;
}

export function select({ value, options, onChange, className = 'select', ariaLabel, id }) {
  const el = h('select', { class: className, 'aria-label': ariaLabel, id, onChange: (e) => onChange?.(e.target.value) });
  for (const [val, label] of options) el.append(h('option', { value: val, selected: val === value }, label));
  el.value = value ?? '';
  return el;
}

export function toggle({ checked, onChange, ariaLabel, disabled }) {
  const input = h('input', { type: 'checkbox', checked, disabled, 'aria-label': ariaLabel, onChange: (e) => onChange?.(e.target.checked) });
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }));
}

export function settingRow({ label, hint, control }) {
  return h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', { class: 'label' }, label), hint ? h('div', { class: 'hint' }, hint) : null), control);
}

export function empty({ iconName = 'message', title, text, action }) {
  return h('div', { class: 'empty' }, icon(iconName, 32), h('h3', {}, title), text ? h('p', {}, text) : null, action ?? null);
}

// ---------- toasts ----------

let toastRoot;

export function toast(message, { type = 'info', duration = 3200, action } = {}) {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRoot);
  }
  const el = h('div', { class: `toast ${type === 'error' ? 'error' : ''}` }, h('span', { class: 'grow' }, message));
  if (action) {
    el.append(
      h(
        'button',
        {
          class: 'text-btn',
          onClick: () => {
            action.onClick();
            el.remove();
          },
        },
        action.label,
      ),
    );
  }
  toastRoot.append(el);
  while (toastRoot.children.length > 3) toastRoot.firstChild.remove();
  setTimeout(() => el.remove(), action ? Math.max(duration, 6000) : duration);
  return el;
}

// ---------- modals ----------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function modal({ title, body, actions = [], onClose }) {
  const opener = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    // give focus back to whatever opened the dialog (keyboard users lose their place otherwise)
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // keep Tab inside the dialog
    const items = Array.from(box.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  };
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  box.append(h('div', { class: 'row between' }, h('h2', {}, title), button({ iconName: 'x', className: 'btn icon', title: 'Close', onClick: close })));
  append(box, [body]);
  if (actions.length) {
    box.append(
      h(
        'div',
        { class: 'actions' },
        actions.map((a) =>
          button({
            label: a.label,
            iconName: a.iconName,
            className: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`,
            onClick: async () => {
              const keep = await a.onClick?.();
              if (!keep) close();
            },
          }),
        ),
      ),
    );
  }
  const backdrop = h('div', { class: 'modal-backdrop', onClick: (e) => e.target === backdrop && close() }, box);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  // initial focus: the first control in the body, else the first action button, else the close button
  setTimeout(() => {
    if (closed) return;
    const inBody = Array.from(box.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    const preferred = inBody.find((el) => !el.closest('.row.between') && !el.closest('.actions')) ?? inBody.find((el) => el.closest('.actions')) ?? inBody[0];
    preferred?.focus({ preventScroll: true });
  }, 0);
  return { close, box };
}

export function confirm({ title, text, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let decided = false;
    modal({
      title,
      body: h('p', { class: 'muted', style: { margin: 0 } }, text),
      onClose: () => !decided && resolve(false),
      actions: [
        { label: 'Cancel', onClick: () => (decided = true) && resolve(false) },
        { label: confirmLabel, primary: !danger, danger, onClick: () => (decided = true) && resolve(true) },
      ],
    });
  });
}

export function prompt({ title, text, value = '', placeholder = '', confirmLabel = 'Save', multiline = false }) {
  return new Promise((resolve) => {
    let decided = false;
    const input = multiline ? h('textarea', { class: 'textarea', value, placeholder }) : h('input', { class: 'input', value, placeholder });
    const { close } = modal({
      title,
      body: [text ? h('p', { class: 'muted small', style: { margin: 0 } }, text) : null, input],
      onClose: () => !decided && resolve(null),
      actions: [
        { label: 'Cancel', onClick: () => (decided = true) && resolve(null) },
        { label: confirmLabel, primary: true, onClick: () => (decided = true) && resolve(input.value) },
      ],
    });
    setTimeout(() => input.focus(), 30);
    if (!multiline) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          decided = true;
          resolve(input.value);
          close(); // through close() so the key listener and focus are cleaned up
        }
      });
    }
  });
}

/** Remember focus + caret across a re-render so typing in search boxes is not interrupted. */
export function preserveFocus(render) {
  const active = document.activeElement;
  const id = active?.id;
  const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  render();
  if (!id) return;
  const next = document.getElementById(id);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (sel && 'setSelectionRange' in next) {
    try {
      next.setSelectionRange(sel[0], sel[1]);
    } catch {
      /* ignore */
    }
  }
}

export function copyText(text) {
  return navigator.clipboard.writeText(text);
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function pickFile(accept = 'application/json') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}
