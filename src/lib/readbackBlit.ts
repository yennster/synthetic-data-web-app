export type ReadbackBlitState = {
  pixels: Uint8Array | null;
  image: ImageData | null;
  rowViews: Uint8Array[];
  width: number;
  height: number;
};

export function createReadbackBlitState(): ReadbackBlitState {
  return {
    pixels: null,
    image: null,
    rowViews: [],
    width: 0,
    height: 0,
  };
}

export function resetReadbackBlitState(state: ReadbackBlitState): void {
  state.pixels = null;
  state.image = null;
  state.rowViews = [];
  state.width = 0;
  state.height = 0;
}

export function ensureReadbackBlitState(
  state: ReadbackBlitState,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): Uint8Array {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const byteLength = w * h * 4;

  if (
    !state.pixels ||
    state.pixels.length !== byteLength ||
    state.width !== w ||
    state.height !== h
  ) {
    state.pixels = new Uint8Array(byteLength);
    const rowBytes = w * 4;
    state.rowViews = Array.from({ length: h }, (_, y) =>
      state.pixels!.subarray(y * rowBytes, (y + 1) * rowBytes),
    );
    state.width = w;
    state.height = h;
  }

  if (!state.image || state.image.width !== w || state.image.height !== h) {
    state.image = ctx.createImageData(w, h);
  }

  return state.pixels;
}

export function putFlippedReadback(
  ctx: CanvasRenderingContext2D,
  state: ReadbackBlitState,
): void {
  const image = state.image;
  if (!image) return;

  const { width, height } = state;
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    image.data.set(state.rowViews[height - 1 - y], y * rowBytes);
  }
  ctx.putImageData(image, 0, 0);
}
