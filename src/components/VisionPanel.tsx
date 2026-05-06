import { useEffect, useRef, useState } from 'react';
import { useStore, type ObjectKind } from '../store/useStore';
import {
  buildBoundingBoxLabelsFile,
  fsAccessSupported,
  pickDirectory,
  saveBlob,
} from '../lib/capture';
import { uploadCaptures } from '../lib/edgeImpulse';
import { disposeUsdz, loadUsdz } from '../lib/usdz';

const OBJECT_OPTIONS: ObjectKind[] = [
  'cube',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'capsule',
  'phone',
];

export function VisionPanel() {
  const {
    mode,
    sceneObjects,
    addSceneObject,
    removeSceneObject,
    updateSceneObject,
    clearSceneObjects,
    showConveyor,
    setShowConveyor,
    conveyorSpeed,
    setConveyorSpeed,
    assets,
    addAsset,
    removeAsset,
    updateAsset,
    clearAssets,
    capture: cs,
    setCapture,
    captures,
    clearCaptures,
    triggerCapture,
    triggerBatch,
    saveDirHandle,
    setSaveDirHandle,
    anomalyLabel,
    setAnomalyLabel,
    ei,
    setEi,
    status,
    setStatus,
  } = useStore();

  const [newKind, setNewKind] = useState<ObjectKind>('cube');
  const [newLabel, setNewLabel] = useState('cube');
  // When the user picks a different kind in the dropdown, auto-update the
  // label to match — so "sphere" gets labelled "sphere" by default instead
  // of inheriting the previous "cube" label. Users can still type a custom
  // label after selecting the kind.
  const lastKindRef = useRef<ObjectKind>('cube');
  useEffect(() => {
    if (lastKindRef.current !== newKind) {
      setNewLabel(newKind);
      lastKindRef.current = newKind;
    }
  }, [newKind]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importLabel, setImportLabel] = useState('');

  const onImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setStatus('busy', `Importing ${files.length} asset(s)…`);
    let count = 0;
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith('.usdz')) {
        setStatus(
          'err',
          `${file.name}: only .usdz files are supported (see README for .usd conversion).`,
        );
        continue;
      }
      try {
        const {
          object,
          maxDim,
          meshCount,
          triangleCount,
          defaultMaterialMeshes,
        } = await loadUsdz(file);

        // Smarter auto-scaling: don't crush room-sized assets down to 1m
        // (which makes coplanar floor decals z-fight at sub-mm scale and
        // looks like the "magenta crinkly" pattern). Only normalise the
        // extreme cases.
        //   maxDim > 3   → scale so largest dim is 3m   (rooms / vehicles)
        //   maxDim < 0.05 → scale so largest dim is 0.1m (tiny assets)
        //   otherwise    → keep scale = 1
        let initialScale = 1;
        if (maxDim > 3) initialScale = 3 / maxDim;
        else if (maxDim < 0.05) initialScale = 0.1 / maxDim;

        // If most meshes look like the OpenUSD WASM magenta placeholder
        // (e.g. an Omniverse asset with MDL materials), pre-enable the
        // material override so the user sees something usable immediately.
        const placeholderRatio =
          meshCount > 0 ? defaultMaterialMeshes / meshCount : 0;
        const autoOverride = placeholderRatio > 0.5;

        const id = crypto.randomUUID();
        const baseName = file.name.replace(/\.usdz$/i, '');
        addAsset({
          id,
          name: baseName,
          label: importLabel.trim() || baseName,
          object,
          position: [
            (assets.length + count) * 1.0 - 1.5,
            0,
            0,
          ],
          rotation: [0, 0, 0],
          scale: initialScale,
          physics: false,
          overrideMaterial: autoOverride,
          overrideColor: '#a78bfa',
          overrideRoughness: 0.5,
          overrideMetalness: 0.1,
        });

        // Surface what we got so the user can debug Omniverse / usdzip
        // ingest issues without opening DevTools.
        const summary = `${meshCount} meshes · ${triangleCount.toLocaleString()} tris · ${maxDim.toFixed(2)}m max`;
        const matNote =
          defaultMaterialMeshes === 0
            ? ''
            : ` · ${defaultMaterialMeshes}/${meshCount} default-material${autoOverride ? ' (override auto-enabled)' : ''}`;
        setStatus('ok', `Imported ${baseName}.usdz: ${summary}${matNote}`);

        count += 1;
      } catch (e) {
        setStatus('err', `${file.name}: ${(e as Error).message}`);
      }
    }
    setStatus('ok', `Imported ${count} asset(s)`);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onRemoveAsset = (id: string) => {
    const a = assets.find((x) => x.id === id);
    if (a) disposeUsdz(a.object);
    removeAsset(id);
  };

  const onClearAssets = () => {
    for (const a of assets) disposeUsdz(a.object);
    clearAssets();
  };

  const onPickDir = async () => {
    try {
      const h = await pickDirectory();
      if (h) {
        setSaveDirHandle(h);
        setStatus('ok', `Saving to: ${h.name}/`);
      }
    } catch (e) {
      setStatus('err', `Picker: ${(e as Error).message}`);
    }
  };

  const onSaveLabelsFile = async () => {
    if (!saveDirHandle) {
      setStatus('err', 'Pick a directory first');
      return;
    }
    const json = buildBoundingBoxLabelsFile(captures);
    await saveBlob(
      { kind: 'fs', dir: saveDirHandle },
      'bounding_boxes.labels',
      new Blob([json], { type: 'application/json' }),
    );
    setStatus('ok', 'Wrote bounding_boxes.labels');
  };

  const onUpload = async () => {
    setStatus('busy', `Uploading 0/${captures.length}…`);
    const includeBoxes = mode === 'detection';
    const defaultLabel = mode === 'anomaly' ? anomalyLabel : ei.label;
    const result = await uploadCaptures(
      ei,
      captures,
      defaultLabel,
      includeBoxes,
      (p) => {
        setStatus(
          'busy',
          `Uploading ${p.done}/${p.total}${p.failed ? ` · ${p.failed} failed` : ''}`,
        );
      },
    );
    if (result.failed === 0) {
      setStatus('ok', `Uploaded ${result.done} images`);
    } else {
      setStatus(
        'err',
        `${result.done} ok / ${result.failed} failed: ${result.lastError ?? '?'}`,
      );
    }
  };

  return (
    <>
      <div className="card">
        <h3>Scene</h3>
        <label className="field">
          <span className="row" style={{ alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={showConveyor}
              onChange={(e) => setShowConveyor(e.target.checked)}
              style={{ width: 'auto', flex: 'none' }}
            />
            <span style={{ flex: 1 }}>Conveyor belt</span>
          </span>
        </label>
        {showConveyor && (
          <label className="field">
            Belt speed {conveyorSpeed.toFixed(2)} m/s
            <input
              type="range"
              min={-2}
              max={2}
              step={0.05}
              value={conveyorSpeed}
              onChange={(e) => setConveyorSpeed(Number(e.target.value))}
            />
          </label>
        )}
      </div>

      <div className="card">
        <h3>Objects ({sceneObjects.length})</h3>
        <div className="row">
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as ObjectKind)}
          >
            {OBJECT_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="label"
          />
        </div>
        <div className="row">
          <button onClick={() => addSceneObject(newKind, newLabel || newKind)}>
            + Add
          </button>
          <button onClick={clearSceneObjects} disabled={sceneObjects.length === 0}>
            Clear all
          </button>
        </div>
        {sceneObjects.length > 0 && (
          <div
            style={{
              maxHeight: 160,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              marginTop: 4,
            }}
          >
            {sceneObjects.map((o) => (
              <div
                key={o.id}
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    background: o.color,
                    borderRadius: 3,
                  }}
                />
                <input
                  value={o.label}
                  onChange={(e) =>
                    updateSceneObject(o.id, { label: e.target.value })
                  }
                  style={{ flex: 1, padding: '3px 6px' }}
                />
                <span style={{ color: 'var(--muted)' }}>{o.kind}</span>
                <button
                  onClick={() => removeSceneObject(o.id)}
                  style={{ padding: '2px 6px' }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Import (.usdz) ({assets.length})</h3>
        <input
          ref={fileInputRef}
          type="file"
          accept=".usdz"
          multiple
          onChange={(e) => onImportFiles(e.target.files)}
          style={{ fontSize: 11 }}
        />
        <label className="field">
          Default label
          <input
            value={importLabel}
            onChange={(e) => setImportLabel(e.target.value)}
            placeholder="(uses filename if blank)"
          />
        </label>
        {assets.length > 0 && (
          <>
            <button onClick={onClearAssets}>Clear all</button>
            <div
              style={{
                maxHeight: 220,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {assets.map((a) => (
                <div
                  key={a.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: 6,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    fontSize: 11,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span
                      style={{
                        color: 'var(--muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={a.name}
                    >
                      {a.name}.usdz
                    </span>
                    <button
                      onClick={() => onRemoveAsset(a.id)}
                      style={{ padding: '2px 6px' }}
                    >
                      ×
                    </button>
                  </div>
                  <input
                    value={a.label}
                    onChange={(e) => updateAsset(a.id, { label: e.target.value })}
                    placeholder="label"
                    style={{ padding: '3px 6px' }}
                  />
                  <label className="field" style={{ gap: 2 }}>
                    Scale {a.scale.toFixed(2)}
                    <input
                      type="range"
                      min={0.001}
                      max={5}
                      step={0.01}
                      value={a.scale}
                      onChange={(e) =>
                        updateAsset(a.id, { scale: Number(e.target.value) })
                      }
                    />
                  </label>
                  <div className="row">
                    {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                      <label className="field" key={axis} style={{ gap: 2 }}>
                        {axis}
                        <input
                          type="number"
                          step={0.1}
                          value={a.position[i]}
                          onChange={(e) => {
                            const next = [...a.position] as [number, number, number];
                            next[i] = Number(e.target.value);
                            updateAsset(a.id, { position: next });
                          }}
                          style={{ padding: '3px 6px' }}
                        />
                      </label>
                    ))}
                  </div>
                  <label className="field" style={{ gap: 2 }}>
                    Yaw {((a.rotation[1] * 180) / Math.PI).toFixed(0)}°
                    <input
                      type="range"
                      min={-Math.PI}
                      max={Math.PI}
                      step={0.05}
                      value={a.rotation[1]}
                      onChange={(e) =>
                        updateAsset(a.id, {
                          rotation: [
                            a.rotation[0],
                            Number(e.target.value),
                            a.rotation[2],
                          ],
                        })
                      }
                    />
                  </label>
                  <label
                    className="field"
                    style={{
                      gap: 2,
                      flexDirection: 'row',
                      alignItems: 'center',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={a.physics}
                      onChange={(e) =>
                        updateAsset(a.id, { physics: e.target.checked })
                      }
                      style={{ width: 'auto', flex: 'none' }}
                    />
                    <span style={{ flex: 1, textTransform: 'none', letterSpacing: 0 }}>
                      Physics (falls, collides, rides belt)
                    </span>
                  </label>
                  <label
                    className="field"
                    style={{
                      gap: 2,
                      flexDirection: 'row',
                      alignItems: 'center',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={a.overrideMaterial}
                      onChange={(e) =>
                        updateAsset(a.id, { overrideMaterial: e.target.checked })
                      }
                      style={{ width: 'auto', flex: 'none' }}
                    />
                    <span style={{ flex: 1, textTransform: 'none', letterSpacing: 0 }}>
                      Override material (use if it&apos;s pink)
                    </span>
                  </label>
                  {a.overrideMaterial && (
                    <div className="row" style={{ alignItems: 'center', gap: 6 }}>
                      <input
                        type="color"
                        value={a.overrideColor}
                        onChange={(e) =>
                          updateAsset(a.id, { overrideColor: e.target.value })
                        }
                        style={{ flex: 'none', width: 32, height: 28, padding: 0 }}
                      />
                      <label className="field" style={{ gap: 0, flex: 1 }}>
                        Rough
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={a.overrideRoughness}
                          onChange={(e) =>
                            updateAsset(a.id, {
                              overrideRoughness: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="field" style={{ gap: 0, flex: 1 }}>
                        Metal
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={a.overrideMetalness}
                          onChange={(e) =>
                            updateAsset(a.id, {
                              overrideMetalness: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          Drop in <code>.usdz</code> files (zipped USD). For{' '}
          <code>.usd</code> / <code>.usda</code> / <code>.usdc</code>, convert
          first via Blender, Omniverse, or <code>usdcat</code> (see README).
        </div>
      </div>

      <div className="card">
        <h3>Virtual camera</h3>
        <div className="row">
          <label className="field">
            Width
            <input
              type="number"
              min={64}
              max={2048}
              step={32}
              value={cs.width}
              onChange={(e) =>
                setCapture({ width: Number(e.target.value) || 640 })
              }
            />
          </label>
          <label className="field">
            Height
            <input
              type="number"
              min={64}
              max={2048}
              step={32}
              value={cs.height}
              onChange={(e) =>
                setCapture({ height: Number(e.target.value) || 480 })
              }
            />
          </label>
        </div>
        <label className="field">
          FOV {cs.fov.toFixed(0)}°
          <input
            type="range"
            min={20}
            max={90}
            step={1}
            value={cs.fov}
            onChange={(e) => setCapture({ fov: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          Light intensity {cs.lightIntensity.toFixed(2)}
          <input
            type="range"
            min={0.2}
            max={2.5}
            step={0.05}
            value={cs.lightIntensity}
            onChange={(e) =>
              setCapture({ lightIntensity: Number(e.target.value) })
            }
          />
        </label>
        <label className="field">
          Cam X / Y / Z
          <div className="row">
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                type="number"
                step={0.1}
                value={cs.camPos[i]}
                onChange={(e) => {
                  const next = [...cs.camPos] as [number, number, number];
                  next[i] = Number(e.target.value);
                  setCapture({ camPos: next });
                }}
              />
            ))}
          </div>
        </label>
      </div>

      <div className="card">
        <h3>Capture</h3>
        {mode === 'anomaly' && (
          <label className="field">
            Batch label
            <input
              value={anomalyLabel}
              onChange={(e) => setAnomalyLabel(e.target.value)}
              placeholder="normal | anomaly"
            />
          </label>
        )}
        <button onClick={() => triggerCapture()} className="primary">
          📸 Capture frame
        </button>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
          <label className="field">
            Batch count
            <input
              type="number"
              min={1}
              max={500}
              step={1}
              value={cs.batchCount}
              onChange={(e) =>
                setCapture({ batchCount: Number(e.target.value) || 10 })
              }
            />
          </label>
          <label className="field">
            <span className="row" style={{ alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={cs.randomizeCamera}
                onChange={(e) =>
                  setCapture({ randomizeCamera: e.target.checked })
                }
                style={{ width: 'auto', flex: 'none' }}
              />
              <span style={{ flex: 1 }}>Randomize camera</span>
            </span>
          </label>
          <label className="field">
            <span className="row" style={{ alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={cs.randomizeLighting}
                onChange={(e) =>
                  setCapture({ randomizeLighting: e.target.checked })
                }
                style={{ width: 'auto', flex: 'none' }}
              />
              <span style={{ flex: 1 }}>Randomize lighting</span>
            </span>
          </label>
          <label className="field">
            <span className="row" style={{ alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={cs.randomizeObjects}
                onChange={(e) =>
                  setCapture({ randomizeObjects: e.target.checked })
                }
                style={{ width: 'auto', flex: 'none' }}
              />
              <span style={{ flex: 1 }}>Randomize objects</span>
            </span>
          </label>
          <button onClick={() => triggerBatch()} className="primary">
            ⚡ Capture batch ({cs.batchCount})
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {captures.length} captures
        </div>
        <button onClick={clearCaptures} disabled={captures.length === 0}>
          Clear captures
        </button>
      </div>

      <div className="card">
        <h3>Save directory</h3>
        {fsAccessSupported() ? (
          <>
            <button onClick={onPickDir}>
              {saveDirHandle ? `📂 ${saveDirHandle.name}/` : 'Choose directory…'}
            </button>
            {mode === 'detection' && (
              <button
                onClick={onSaveLabelsFile}
                disabled={!saveDirHandle || captures.length === 0}
              >
                💾 Write bounding_boxes.labels
              </button>
            )}
          </>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            File System Access API not supported in this browser. Captures will
            download individually to your Downloads folder.
          </div>
        )}
      </div>

      <div className="card">
        <h3>Edge Impulse</h3>
        <label className="field">
          API Key
          <input
            type="password"
            value={ei.apiKey}
            onChange={(e) => setEi({ apiKey: e.target.value })}
            placeholder="ei_..."
            autoComplete="off"
          />
        </label>
        <label className="field">
          Category
          <select
            value={ei.category}
            onChange={(e) =>
              setEi({ category: e.target.value as 'training' | 'testing' })
            }
          >
            <option value="training">Training</option>
            <option value="testing">Testing</option>
          </select>
        </label>
        {mode === 'anomaly' && (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Each capture is uploaded with the batch label above. Bounding
            boxes are <strong>not</strong> attached.
          </div>
        )}
        {mode === 'detection' && (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Each capture is uploaded with bounding boxes ({captures.reduce(
              (acc, c) => acc + c.boxes.length,
              0,
            )} total).
          </div>
        )}
        <button
          className="primary"
          onClick={onUpload}
          disabled={
            captures.length === 0 || !ei.apiKey || status.kind === 'busy'
          }
        >
          ⤴ Upload {captures.length} images
        </button>
      </div>
    </>
  );
}
