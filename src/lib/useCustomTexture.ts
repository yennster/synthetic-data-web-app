import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { getCustomTexture, type TextureKind } from './textureStore';

/**
 * Pull a user-uploaded texture blob out of IndexedDB and turn it into a
 * `THREE.Texture`, refreshing whenever `name` changes. Returns `null`
 * while loading or when the slot is empty.
 *
 * The hook depends on `name` (not the blob bytes) so multi-megabyte image
 * uploads don't sit on a fiber — only the GPU handle does. Pre-existing
 * textures are disposed when the slot turns over or the consumer unmounts.
 *
 * `repeat` is the default tile count applied to both axes; for floor/wall
 * surfaces this is the visible tile density, for shape objects 1 keeps
 * the photo aligned to the shape's own UVs.
 */
export function useCustomTexture(
  kind: TextureKind,
  name: string | null | undefined,
  opts: { repeat?: number; anisotropy?: number } = {},
): THREE.Texture | null {
  const repeat = opts.repeat ?? 1;
  const anisotropy = opts.anisotropy ?? 4;
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    if (!name) {
      setTex(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    let active: THREE.Texture | null = null;
    (async () => {
      try {
        const blob = await getCustomTexture(kind);
        if (cancelled || !blob) {
          setTex(null);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        const loader = new THREE.TextureLoader();
        const t = await new Promise<THREE.Texture>((resolve, reject) =>
          loader.load(objectUrl!, resolve, undefined, reject),
        );
        if (cancelled) {
          t.dispose();
          return;
        }
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(repeat, repeat);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = anisotropy;
        active = t;
        setTex(t);
      } catch (err) {
        console.warn(`[textures] failed to load custom ${kind}:`, err);
        setTex(null);
      }
    })();
    return () => {
      cancelled = true;
      if (active) active.dispose();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, name, repeat, anisotropy]);
  return tex;
}
