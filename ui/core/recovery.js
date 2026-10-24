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
    clear() { return enqueue(() => tauri.core.invoke('clear_recovery')); }
  };
}
