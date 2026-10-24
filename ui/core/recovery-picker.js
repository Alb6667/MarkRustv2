import { formatSavedAt } from './drafts.js';

// DOM text nodes only: paths from recovery files must never become HTML.
export function pickRecovery(document, rows) {
  const dialog = document.getElementById('recovery-dialog');
  const list = document.getElementById('recovery-list');
  list.replaceChildren();
  return new Promise((resolve) => {
    function finish(id) {
      dialog.removeEventListener('close', cancel);
      dialog.close();
      resolve(id);
    }
    function cancel() { finish(null); }
    for (const row of rows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = (row.path || 'Tanpa Judul') + ' — ' + formatSavedAt(row.savedAt);
      button.addEventListener('click', () => finish(row.id), { once: true });
      list.appendChild(button);
    }
    dialog.addEventListener('close', cancel, { once: true });
    dialog.showModal();
  });
}
