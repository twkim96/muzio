/** Migration only: reclaim abandoned bytes written by the former browser DVR.
 * Leave leases from still-running older tabs alone. New playback never writes here.
 */
export async function sweepLegacyHlsCache(now = Date.now()): Promise<void> {
  const opening = indexedDB.open('muzio-temporary-hls-v1', 1);
  opening.onupgradeneeded = () => opening.transaction?.abort(); // Do not create a new legacy database.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  try {
    if (!['bytes', 'meta', 'sessions'].every(name => db.objectStoreNames.contains(name))) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['bytes', 'meta', 'sessions'], 'readwrite');
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
      const leases = tx.objectStore('sessions').getAll();
      leases.onsuccess = () => {
        const active = new Set((leases.result as {id: string; at: number}[]).filter(row => now - row.at < 5 * 60_000).map(row => row.id));
        for (const row of leases.result as {id: string}[]) if (!active.has(row.id)) tx.objectStore('sessions').delete(row.id);
        const cursor = tx.objectStore('meta').openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result; if (!row) return;
          if (!active.has(row.value.session)) { tx.objectStore('bytes').delete(row.primaryKey); row.delete(); }
          row.continue();
        };
      };
    });
  } finally { db.close(); }
}
