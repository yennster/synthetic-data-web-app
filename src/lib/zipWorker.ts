import { buildZip, type ZipEntry } from './zip';

type ZipWorkerRequest = {
  id: number;
  entries: ZipEntry[];
};

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

const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent<ZipWorkerRequest>) => void) | null;
  postMessage: (message: ZipWorkerResponse) => void;
};

workerSelf.onmessage = (event) => {
  const { id, entries } = event.data;
  void (async () => {
    try {
      const blob = await buildZip(entries);
      workerSelf.postMessage({ id, ok: true, blob });
    } catch (err) {
      workerSelf.postMessage({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};

export {};
