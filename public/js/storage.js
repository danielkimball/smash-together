function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("smash64-online", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function get(key) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const r = d.transaction("files").objectStore("files").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}
export async function put(key, value) {
  const d = await db();
  try {
    await new Promise((resolve, reject) => {
      const t = d.transaction("files", "readwrite");
      if (value === undefined) t.objectStore("files").delete(key);
      else t.objectStore("files").put(value, key);
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  } finally {
    d.close();
  }
  // Ask the browser to retain verified cartridges and saves across visits.
  navigator.storage?.persist?.().catch(() => {});
}
