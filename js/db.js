// Lokalna pamięć wyników dla plików (IndexedDB). Klucz = SHA-256 zawartości PDF,
// więc ten sam plik wgrany ponownie (nawet pod inną nazwą) korzysta z zapisanych wyników
// i nie zużywa ponownie tokenów.
const DB_NAME = 'quizmaker';
const STORE = 'docs';
const memory = new Map(); // zapas, gdy IndexedDB jest niedostępne (np. tryb prywatny)

let dbPromise;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'hash' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export async function getDoc(hash) {
  try {
    return (await tx('readonly', (s) => s.get(hash))) || memory.get(hash) || null;
  } catch {
    return memory.get(hash) || null;
  }
}

export async function putDoc(record) {
  record.updatedAt = Date.now();
  memory.set(record.hash, record);
  try { await tx('readwrite', (s) => s.put(record)); } catch { /* zostaje w pamięci */ }
}

/** Lista zapisanych plików (najnowsze najpierw) – tylko metadane potrzebne do listy wyboru. */
export async function listDocs() {
  let all;
  try {
    all = await tx('readonly', (s) => s.getAll());
  } catch {
    all = [...memory.values()];
  }
  return (all || [])
    .map((r) => ({
      hash: r.hash,
      name: r.name,
      numPages: r.numPages,
      pool: r.pool?.length || 0,
      banks: Object.keys(r.banks || {}).length,
      assessed: !!r.assessment,
      updatedAt: r.updatedAt || 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDoc(hash) {
  memory.delete(hash);
  try { await tx('readwrite', (s) => s.delete(hash)); } catch { /* ignoruj */ }
}

export async function sha256(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
