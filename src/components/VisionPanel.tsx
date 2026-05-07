import { useEffect, useRef, useState } from 'react';
import { useStore, type ObjectKind } from '../store/useStore';
import {
  buildBoundingBoxLabelsFile,
  fsAccessSupported,
  pickDirectory,
  saveBlob,
} from '../lib/capture';
import {
  downloadEiDeployment,
  getEiDeployment,
  listEiProjects,
  uploadCaptures,
  type EiProject,
} from '../lib/edgeImpulse';
import { loadEiModel, loadEiModelFromZip } from '../lib/eiModel';
import { disposeUsdz, loadUsdz } from '../lib/usdz';
import { EiAuthCard } from './EiAuthCard';

const OBJECT_OPTIONS: ObjectKind[] = [
  'cube',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'capsule',
  'phone',
  'soda_can',
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
    envPreset,
    setEnvPreset,
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

  const eiModel = useStore((s) => s.eiModel);
  const eiModelInfo = useStore((s) => s.eiModelInfo);
  const eiModelName = useStore((s) => s.eiModelName);
  const setEiModel = useStore((s) => s.setEiModel);
  const eiThreshold = useStore((s) => s.eiThreshold);
  const setEiThreshold = useStore((s) => s.setEiThreshold);
  const eiLive = useStore((s) => s.eiLive);
  const setEiLive = useStore((s) => s.setEiLive);
  const eiResult = useStore((s) => s.eiResult);
  const eiShow3D = useStore((s) => s.eiShow3D);
  const setEiShow3D = useStore((s) => s.setEiShow3D);
  const triggerInference = useStore((s) => s.triggerInference);
  const modelFilesRef = useRef<HTMLInputElement>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [eiProjects, setEiProjects] = useState<EiProject[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);

  const onListProjects = async () => {
    if (!ei.apiKey) {
      setStatus('err', 'Enter your Edge Impulse API key first');
      return;
    }
    setStatus('busy', 'Listing projects…');
    try {
      const list = await listEiProjects(ei.apiKey);
      setEiProjects(list);
      if (list.length === 0) {
        setStatus('err', 'No projects accessible to this API key');
      } else {
        if (list.length === 1) setSelectedProjectId(list[0].id);
        setStatus('ok', `Found ${list.length} project${list.length === 1 ? '' : 's'}`);
      }
    } catch (e) {
      setStatus('err', `List projects: ${(e as Error).message}`);
    }
  };

  const onFetchModel = async () => {
    if (!ei.apiKey) {
      setStatus('err', 'Enter your Edge Impulse API key first');
      return;
    }
    if (!selectedProjectId) {
      setStatus('err', 'Pick a project first');
      return;
    }
    setModelLoading(true);
    try {
      setStatus('busy', 'Checking deployment…');
      const info = await getEiDeployment(ei.apiKey, selectedProjectId, 'wasm');
      if (!info.hasDeployment) {
        setStatus(
          'err',
          'No WebAssembly deployment built yet. In the Studio: Deployment → Build with target "WebAssembly".',
        );
        return;
      }
      setStatus('busy', 'Downloading model…');
      const zip = await downloadEiDeployment(ei.apiKey, selectedProjectId, 'wasm');
      setStatus('busy', `Loading model (${(zip.size / 1024).toFixed(0)} KB)…`);
      const projName =
        eiProjects?.find((p) => p.id === selectedProjectId)?.name ??
        `project-${selectedProjectId}`;
      const loaded = await loadEiModelFromZip(zip, projName);
      setEiModel(loaded, projName);
      const i = loaded.info;
      setStatus(
        'ok',
        `Loaded ${projName}: ${i.inputWidth}×${i.inputHeight} ${
          i.isRgb ? 'RGB' : 'GRAY'
        }${i.isObjectDetection ? ' · object detection' : ''}`,
      );
    } catch (e) {
      setStatus('err', `Fetch model: ${(e as Error).message}`);
    } finally {
      setModelLoading(false);
    }
  };

  const onLoadModel = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    let jsFile: File | null = null;
    let wasmFile: File | null = null;
    for (const f of Array.from(files)) {
      if (f.name.toLowerCase().endsWith('.wasm')) wasmFile = f;
      else if (f.name.toLowerCase().endsWith('.js')) jsFile = f;
    }
    if (!jsFile || !wasmFile) {
      setStatus(
        'err',
        'Pick BOTH the EI .js and .wasm from the unzipped WebAssembly deployment.',
      );
      return;
    }
    setModelLoading(true);
    setStatus('busy', `Loading model ${jsFile.name}…`);
    try {
      const loaded = await loadEiModel(jsFile, wasmFile, jsFile.name);
      setEiModel(loaded, jsFile.name.replace(/\.js$/i, ''));
      const i = loaded.info;
      setStatus(
        'ok',
        `Loaded ${jsFile.name}: ${i.inputWidth}×${i.inputHeight} ${
          i.isRgb ? 'RGB' : 'GRAY'
        }${i.isObjectDetection ? ' · object detection' : ''}${
          i.hasVisualAnomaly ? ' · visual anomaly' : ''
        }`,
      );
    } catch (e) {
      setStatus('err', `Model load: ${(e as Error).message}`);
    } finally {
      setModelLoading(false);
      if (modelFilesRef.current) modelFilesRef.current.value = '';
    }
  };

  const onUnloadModel = () => {
    setEiModel(null);
    setEiLive(false);
    setStatus('ok', 'Model unloaded');
  };

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
          Environment
          <select
            value={envPreset}
            onChange={(e) =>
              setEnvPreset(e.target.value as typeof envPreset)
            }
          >
            <option value="studio">Studio (dark, no walls)</option>
            <option value="warehouse">Warehouse (concrete + walls)</option>
            <option value="whitebox">White box (cyclorama)</option>
            <option value="outdoor">Outdoor (grass + sky)</option>
          </select>
        </label>
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
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 12,
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: 6,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                  }}
                >
                  <input
                    type="color"
                    value={o.color}
                    onChange={(e) =>
                      updateSceneObject(o.id, { color: e.target.value })
                    }
                    title={`Color: ${o.color}`}
                    style={{ flex: 'none', width: 16, height: 16 }}
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
                <label
                  className="field"
                  style={{ gap: 2, fontSize: 10 }}
                >
                  Size
                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                    }}
                  >
                    <input
                      type="range"
                      min={0.1}
                      max={5}
                      step={0.05}
                      value={o.scale}
                      onChange={(e) =>
                        updateSceneObject(o.id, {
                          scale: Number(e.target.value),
                        })
                      }
                      style={{ flex: 1 }}
                    />
                    <input
                      type="number"
                      min={0.1}
                      max={5}
                      step={0.05}
                      value={o.scale}
                      onChange={(e) =>
                        updateSceneObject(o.id, {
                          scale: Number(e.target.value) || 0.1,
                        })
                      }
                      style={{
                        width: 64,
                        flex: 'none',
                        padding: '3px 6px',
                      }}
                    />
                  </div>
                </label>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    color: 'var(--muted)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={o.physics}
                    onChange={(e) =>
                      updateSceneObject(o.id, { physics: e.target.checked })
                    }
                    style={{ width: 'auto', flex: 'none' }}
                  />
                  <span>Physics (falls, collides, rides belt)</span>
                </label>
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
                    Scale
                    <div
                      style={{
                        display: 'flex',
                        gap: 6,
                        alignItems: 'center',
                      }}
                    >
                      <input
                        type="range"
                        min={0.001}
                        max={5}
                        step={0.01}
                        value={a.scale}
                        onChange={(e) =>
                          updateAsset(a.id, {
                            scale: Number(e.target.value),
                          })
                        }
                        style={{ flex: 1 }}
                      />
                      <input
                        type="number"
                        min={0.001}
                        max={5}
                        step={0.01}
                        value={a.scale}
                        onChange={(e) =>
                          updateAsset(a.id, {
                            scale: Number(e.target.value) || 0.001,
                          })
                        }
                        style={{
                          width: 64,
                          flex: 'none',
                          padding: '3px 6px',
                        }}
                      />
                    </div>
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

      <div className="card capture-card">
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
        <button
          onClick={() => triggerCapture()}
          className="primary capture-frame-button"
        >
          📸 Capture frame
        </button>

        <div className="capture-batch-section">
          <div className="capture-batch-topline">
            <label className="field capture-batch-count">
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
            <button
              onClick={() => triggerBatch()}
              className="primary capture-batch-button"
            >
              ⚡ Batch ({cs.batchCount})
            </button>
          </div>

          <fieldset className="capture-randomize-group">
            <legend>Randomize</legend>
            <div className="capture-toggle-list">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={cs.randomizeCamera}
                  onChange={(e) =>
                    setCapture({ randomizeCamera: e.target.checked })
                  }
                />
                <span>Camera</span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={cs.randomizeLighting}
                  onChange={(e) =>
                    setCapture({ randomizeLighting: e.target.checked })
                  }
                />
                <span>Lighting</span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={cs.randomizeObjects}
                  onChange={(e) =>
                    setCapture({ randomizeObjects: e.target.checked })
                  }
                />
                <span>Objects</span>
              </label>
            </div>
          </fieldset>
        </div>

        <div className="capture-footer">
          <span>{captures.length} captures</span>
          <button onClick={clearCaptures} disabled={captures.length === 0}>
            Clear
          </button>
        </div>
      </div>

      <EiAuthCard />

      <div className="card ei-inference-card">
        <h3>Inference (Edge Impulse model)</h3>
        {!eiModel ? (
          <>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Fetch directly from your Edge Impulse project, or upload the
              <code> .js</code> + <code>.wasm</code> from a WebAssembly
              deployment. Object detection (YOLO/MobileNet) and FOMO models
              are supported.
            </div>

            <fieldset className="ei-fetch-group">
              <legend>From your project</legend>
              <button
                onClick={onListProjects}
                disabled={modelLoading || !ei.apiKey}
                title={
                  !ei.apiKey
                    ? 'Set your API key in the Edge Impulse · auth card above'
                    : undefined
                }
              >
                {eiProjects ? '↻ Refresh projects' : '🔑 List projects'}
              </button>
            {eiProjects && eiProjects.length > 0 && (
              <>
                <label className="field">
                  Project
                  <select
                    value={selectedProjectId ?? ''}
                    onChange={(e) =>
                      setSelectedProjectId(
                        e.target.value ? Number(e.target.value) : null,
                      )
                    }
                  >
                    <option value="">(pick one)</option>
                    {eiProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.owner ? ` · ${p.owner}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={onFetchModel}
                  disabled={modelLoading || !selectedProjectId}
                  className="primary"
                >
                  ⤓ Fetch & load model
                </button>
              </>
            )}
            </fieldset>

            <fieldset className="ei-fetch-group">
              <legend>From file</legend>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                Upload the <code>.js</code> + <code>.wasm</code> from an
                unzipped EI WebAssembly deployment.
              </div>
              <input
                ref={modelFilesRef}
                type="file"
                accept=".js,.wasm"
                multiple
                disabled={modelLoading}
                onChange={(e) => onLoadModel(e.target.files)}
                style={{ fontSize: 11 }}
              />
            </fieldset>
          </>
        ) : (
          <>
            <div style={{ fontSize: 11 }}>
              <strong>{eiModelName ?? 'model'}</strong>
              <div style={{ color: 'var(--muted)' }}>
                {eiModelInfo &&
                  `${eiModelInfo.inputWidth}×${eiModelInfo.inputHeight} · ${
                    eiModelInfo.isRgb ? 'RGB' : 'GRAY'
                  }${eiModelInfo.isObjectDetection ? ' · obj-det' : ''}${
                    eiModelInfo.hasVisualAnomaly ? ' · anomaly' : ''
                  }`}
                {eiModelInfo && eiModelInfo.labels.length > 0 && (
                  <div style={{ marginTop: 2 }}>
                    {eiModelInfo.labels.length} labels
                    {eiModelInfo.labels.length <= 6 &&
                      `: ${eiModelInfo.labels.join(', ')}`}
                  </div>
                )}
              </div>
            </div>
            <label className="field">
              Threshold {(eiThreshold * 100).toFixed(0)}%
              <input
                type="range"
                min={0.05}
                max={0.95}
                step={0.05}
                value={eiThreshold}
                onChange={(e) => setEiThreshold(Number(e.target.value))}
              />
            </label>
            <div className="row">
              <button onClick={() => triggerInference()} className="primary">
                Run once
              </button>
              <button
                onClick={() => setEiLive(!eiLive)}
                className={eiLive ? 'danger' : ''}
              >
                {eiLive ? '■ Stop live' : '▶ Live'}
              </button>
            </div>
            <label className="check-row" style={{ fontSize: 12 }}>
              <input
                type="checkbox"
                checked={eiShow3D}
                onChange={(e) => setEiShow3D(e.target.checked)}
              />
              <span>Show detections in 3D scene</span>
            </label>
            {eiResult && (
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                {eiResult.bounding_boxes.length} boxes
                {eiResult.classification.length > 0 &&
                  ` · top: ${(() => {
                    const top = [...eiResult.classification].sort(
                      (a, b) => b.value - a.value,
                    )[0];
                    return top ? `${top.label} ${(top.value * 100).toFixed(0)}%` : '';
                  })()}`}
                {typeof eiResult.anomaly === 'number' &&
                  ` · anomaly ${eiResult.anomaly.toFixed(2)}`}
              </div>
            )}
            <button onClick={onUnloadModel}>Unload model</button>
          </>
        )}
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
        <h3>Upload to Edge Impulse</h3>
        {!ei.apiKey && (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Set your API key in the <strong>Edge Impulse · auth</strong> card
            at the top of this panel.
          </div>
        )}
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
