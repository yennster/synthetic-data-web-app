/**
 * IndexedDB-backed blob store for imported `.usdz` files. We persist the
 * original file bytes here (keyed by asset id) so that on page reload we
 * can re-feed them through `loadUsdz()` and rebuild the live three.js
 * Group + needle hydra handle that the renderer needs.
 *
 * The companion metadata (id/name/label/position/scale/etc) lives in
 * Zustand persist (localStorage). Splitting the two keeps the
 * localStorage payload tiny and lets each USDZ — which can easily be
 * 10–20 MB — live in IDB where the quota is much larger.
 */
const DB_NAME = 'sds-assets';
const DB_VERSION = 1;
const STORE = 'usdz';

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putAssetBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await wrap(tx(db, 'readwrite').put(blob, id));
}

export async function getAssetBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  const result = await wrap(tx(db, 'readonly').get(id));
  return (result as Blob | undefined) ?? null;
}

export async function deleteAssetBlob(id: string): Promise<void> {
  const db = await openDb();
  await wrap(tx(db, 'readwrite').delete(id));
}

export async function clearAssetBlobs(): Promise<void> {
  const db = await openDb();
  await wrap(tx(db, 'readwrite').clear());
}

export async function listAssetBlobIds(): Promise<string[]> {
  const db = await openDb();
  const keys = await wrap(tx(db, 'readonly').getAllKeys());
  return (keys as IDBValidKey[]).map((k) => String(k));
}
