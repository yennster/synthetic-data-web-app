import { buildZip, type ZipEntry } from './zip';

type ZipWorkerResponse =
  | {
      id: number;
      ok: true;
      blob: Blob;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

type PendingZip = {
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
};

let zipWorker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingZip>();

function rejectPending(err: Error): void {
  for (const { reject } of pending.values()) {
    reject(err);
  }
  pending.clear();
}

function getZipWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (zipWorker) return zipWorker;

  try {
    zipWorker = new Worker(new URL('./zipWorker.ts', import.meta.url), {
      type: 'module',
      name: 'zip-packager',
    });
  } catch {
    return null;
  }

  zipWorker.addEventListener('message', (event: MessageEvent<ZipWorkerResponse>) => {
    const msg = event.data;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) {
      waiter.resolve(msg.blob);
    } else {
      waiter.reject(new Error(msg.error));
    }
  });

  zipWorker.addEventListener('error', (event) => {
    const err = new Error(event.message || 'Zip worker failed');
    rejectPending(err);
    zipWorker?.terminate();
    zipWorker = null;
  });

  return zipWorker;
}

/**
 * Build a ZIP without blocking the UI thread. Falls back to the in-thread
 * writer in test/unsupported environments where module workers are absent.
 */
export async function buildZipOffThread(entries: ZipEntry[]): Promise<Blob> {
  const worker = getZipWorker();
  if (!worker) return buildZip(entries);

  const id = nextRequestId++;
  return new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, entries });
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
