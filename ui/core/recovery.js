// Serialize native snapshots and clears: an old pending write must not resurrect
// a discarded draft. Continue processing even if a previous disk operation fails.
export function createDiskRecovery(tauri) {
  let queue = Promise.resolve();
  function enqueue(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }
  return {
    write(draft) {
      const contents = JSON.stringify({ ...draft, version: 1 });
      return enqueue(() => tauri.core.invoke('write_recovery', { contents }));
    },
    read() {
      return enqueue(async () => {
        const raw = await tauri.core.invoke('read_recovery');
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (data.version !== 1 || typeof data.markdown !== 'string') throw new Error('Format recovery tidak valid');
        return data;
      });
    },
    list() {
      return enqueue(async () => {
        const raw = await tauri.core.invoke('list_recoveries');
        const rows = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(rows)) throw new Error('Daftar recovery tidak valid');
        return rows;
      });
    },
    select(id) { return enqueue(() => tauri.core.invoke('select_recovery', { id })); },
    fresh() { return enqueue(() => tauri.core.invoke('fresh_recovery')); },
    clear() { return enqueue(() => tauri.core.invoke('clear_recovery')); }
  };
}
