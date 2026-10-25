// Small UI toolkit: menus, dialogs, toasts, progress and context menus.
//
// Everything here is plain DOM so the panel stays dependency free.

const $ = selector => document.querySelector(selector);

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function formatDate(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/* ------------------------------------------------------------------ toasts */

const TOAST_ICONS = { info: 'i-info', ok: 'i-info', warn: 'i-info', err: 'i-info' };

export function toast(message, { title, kind = 'info', timeout = 6000 } = {}) {
  const host = $('#toasts');
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.innerHTML = `
    <svg><use href="#${TOAST_ICONS[kind] ?? 'i-info'}"/></svg>
    <div class="body">${title ? `<strong>${escapeHtml(title)}</strong>` : ''}<span>${escapeHtml(message)}</span></div>
    <button type="button" aria-label="Dismiss">×</button>`;
  const dismiss = () => {
    element.remove();
  };
  element.querySelector('button').addEventListener('click', dismiss);
  host.append(element);
  if (timeout > 0) setTimeout(dismiss, timeout);
  return dismiss;
}

/* ------------------------------------------------------------------- menus */

export function setupMenus(onCommand) {
  const groups = [...document.querySelectorAll('.menu-group')];
  const closeAll = except => {
    for (const group of groups) {
      const button = group.querySelector('.menu-button');
      const panel = group.querySelector('.menu-panel');
      if (group === except) continue;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    }
  };

  for (const group of groups) {
    const button = group.querySelector('.menu-button');
    const panel = group.querySelector('.menu-panel');
    button.addEventListener('click', event => {
      event.stopPropagation();
      const open = panel.hidden;
      closeAll(group);
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    });
    panel.addEventListener('click', event => {
      const command = event.target.closest('[data-cmd]');
      if (!command) return;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      onCommand(command.dataset.cmd);
    });
  }

  document.addEventListener('click', event => {
    if (!event.target.closest('.menu-group')) closeAll();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAll();
  });

  return { closeAll };
}

/* --------------------------------------------------------------- dialog API */

const modalForm = document.querySelector('#modal-form');
modalForm?.addEventListener('submit', event => {
  // A stray Enter in a field must not close the dialog without resolving.
  event.preventDefault();
  document.querySelector('#modal-foot .primary')?.click();
});

function showModal(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

/**
 * Generic dialog. Returns a promise that resolves with the chosen action's
 * value, or null when the dialog is dismissed.
 */
export function openDialog({
  title, subtitle, body, actions = [], width, className = '', onOpen,
}) {
  const dialog = $('#modal-dialog');
  const form = $('#modal-form');
  $('#modal-title').textContent = title;
  const sub = $('#modal-sub');
  sub.textContent = subtitle ?? '';
  sub.hidden = !subtitle;

  const bodyHost = $('#modal-body');
  bodyHost.replaceChildren();
  if (body) {
    if (typeof body === 'string') bodyHost.innerHTML = body;
    else bodyHost.append(body);
  }
  bodyHost.hidden = !body;

  const footer = $('#modal-foot');
  footer.replaceChildren();
  dialog.className = `dialog ${className}`.trim();
  if (width) dialog.style.width = width;
  else dialog.style.removeProperty('width');

  return new Promise(resolve => {
    let result = null;
    const finish = value => {
      if (!dialog.open) return;
      result = value;
      dialog.close();
    };

    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('cancel', onCancel);
      footer.replaceChildren();
      resolve(result);
    };
    const onCancel = event => {
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    };

    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.className = action.kind ?? 'secondary';
      button.disabled = Boolean(action.disabled);
      if (action.id) button.id = action.id;
      button.addEventListener('click', () => {
        if (action.onClick) {
          const value = action.onClick({ close: finish, button });
          if (value === false) return;
        }
        finish(action.value ?? action.label);
      });
      footer.append(button);
    }

    dialog.addEventListener('close', onClose);
    dialog.addEventListener('cancel', onCancel);
    showModal(dialog);
    const focusTarget = bodyHost.querySelector('input, textarea, select') ?? footer.querySelector('.primary');
    focusTarget?.focus?.();
    if (focusTarget instanceof HTMLInputElement) focusTarget.select();
    onOpen?.({ close: finish, body: bodyHost });
  }).finally(() => {
    dialog.style.removeProperty('width');
    dialog.className = 'dialog';
    form.reset();
  });
}

export function confirmDialog({
  title, message, detail, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false,
}) {
  return openDialog({
    title,
    body: `<p class="muted">${escapeHtml(message)}</p>${detail ? `<p class="muted">${escapeHtml(detail)}</p>` : ''}`,
    actions: [
      { label: cancelLabel, value: false, kind: 'secondary' },
      { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  }).then(value => value === true);
}

export function promptDialog({
  title, subtitle, label, value = '', placeholder = '', hint, validate, confirmLabel = 'Create',
}) {
  const field = document.createElement('div');
  field.className = 'field';
  const id = 'prompt-value';
  field.innerHTML = `
    <label for="${id}">${escapeHtml(label ?? 'Name')}</label>
    <input id="${id}" type="text" spellcheck="false" autocomplete="off">
    <span class="hint" id="prompt-hint">${escapeHtml(hint ?? '')}</span>`;
  const input = field.querySelector('input');
  const hintEl = field.querySelector('#prompt-hint');
  input.value = value;
  input.placeholder = placeholder;

  return openDialog({
    title,
    subtitle,
    body: field,
    actions: [
      { label: 'Cancel', value: null, kind: 'secondary' },
      {
        label: confirmLabel,
        kind: 'primary',
        onClick: ({ close }) => {
          const candidate = input.value.trim();
          const problem = validate ? validate(candidate) : null;
          if (problem) {
            hintEl.textContent = problem;
            hintEl.style.color = 'var(--danger)';
            input.focus();
            return false;
          }
          close(candidate);
          return false;
        },
      },
    ],
    onOpen: () => {
      const submit = event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        $('#modal-foot button.primary')?.click();
      };
      input.addEventListener('keydown', submit);
      input.addEventListener('input', () => {
        hintEl.style.color = '';
      });
    },
  });
}

/* --------------------------------------------------------------- progress */

export function progressDialog({ title, cancellable = false, onCancel } = {}) {
  const dialog = $('#progress-dialog');
  const titleEl = $('#progress-title');
  const step = $('#progress-step');
  const detail = $('#progress-detail');
  const fill = $('#progress-fill');
  const cancel = $('#progress-cancel');

  titleEl.textContent = title ?? 'Working…';
  step.textContent = '';
  detail.textContent = '';
  fill.style.width = '0%';
  fill.classList.add('indeterminate');
  cancel.hidden = !cancellable;

  let cancelled = false;
  const cancelHandler = () => {
    cancelled = true;
    cancel.disabled = true;
    cancel.textContent = 'Cancelling…';
    onCancel?.();
  };
  cancel.disabled = false;
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', cancelHandler);

  const blockEscape = event => {
    event.preventDefault();
  };
  dialog.addEventListener('cancel', blockEscape);

  showModal(dialog);

  return {
    get cancelled() {
      return cancelled;
    },
    setStep(text) {
      step.textContent = text ?? '';
    },
    setDetail(text) {
      detail.textContent = text ?? '';
    },
    setFraction(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) {
        fill.classList.add('indeterminate');
        return;
      }
      fill.classList.remove('indeterminate');
      fill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
    },
    close() {
      cancel.removeEventListener('click', cancelHandler);
      dialog.removeEventListener('cancel', blockEscape);
      cancel.hidden = true;
      if (dialog.open) dialog.close();
    },
  };
}

/* ---------------------------------------------------------- context menus */

let contextCleanup = null;

export function showContextMenu(items, x, y) {
  const menu = $('#context-menu');
  hideContextMenu();
  for (const item of items) {
    if (item.rule) {
      const rule = document.createElement('div');
      rule.className = 'menu-rule';
      menu.append(rule);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = item.danger ? 'danger' : '';
    button.disabled = Boolean(item.disabled);
    button.innerHTML = `${item.icon ? `<svg><use href="#${item.icon}"/></svg>` : ''}<span>${escapeHtml(item.label)}</span>`;
    button.addEventListener('click', () => {
      hideContextMenu();
      item.action?.();
    });
    menu.append(button);
  }

  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 6))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 6))}px`;

  const close = event => {
    if (event.type === 'keydown') {
      if (event.key !== 'Escape') return;
    } else if (event.target.closest('.context-menu')) {
      return;
    }
    hideContextMenu();
  };
  setTimeout(() => {
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('blur', hideContextMenu);
  }, 0);
  contextCleanup = () => {
    window.removeEventListener('mousedown', close, true);
    window.removeEventListener('keydown', close, true);
    window.removeEventListener('blur', hideContextMenu);
  };
}

export function hideContextMenu() {
  const menu = $('#context-menu');
  menu.hidden = true;
  menu.replaceChildren();
  contextCleanup?.();
  contextCleanup = null;
}
