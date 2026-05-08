/**
 * IndexedDB-backed blob store for user-uploaded floor / wall textures.
 *
 * Kept separate from `assetStore.ts` because the lifecycle is different:
 * USDZ blobs are looked up by random uuid, whereas custom textures live
 * under a fixed `kind` key (`'floor' | 'wall'`) so loading and replacing
 * them is just a write to that slot. The companion metadata (file
 * name + presence) lives in Zustand persist; the bytes live here.
 */
const DB_NAME = 'sds-textures';
const DB_VERSION = 1;
const STORE = 'textures';

export type TextureKind = 'floor' | 'wall';

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

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putCustomTexture(kind: TextureKind, blob: Blob): Promise<void> {
  const db = await openDb();
  await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, kind));
}

export async function getCustomTexture(kind: TextureKind): Promise<Blob | null> {
  const db = await openDb();
  const r = await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).get(kind));
  return (r as Blob | undefined) ?? null;
}

export async function deleteCustomTexture(kind: TextureKind): Promise<void> {
  const db = await openDb();
  await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(kind));
}

export async function clearCustomTextures(): Promise<void> {
  const db = await openDb();
  await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
}
