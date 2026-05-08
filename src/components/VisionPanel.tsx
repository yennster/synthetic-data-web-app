import { useEffect, useRef, useState } from 'react';
import { useStore, type ObjectKind } from '../store/useStore';
import {
  buildBoundingBoxLabelsFile,
  fsAccessSupported,
  pickDirectory,
  saveBlob,
} from '../lib/capture';
import {
  buildEiDeployment,
  downloadEiHistoricDeployment,
  listEiDeploymentHistory,
  listEiProjects,
  retrainEiModel,
  uploadCaptures,
  waitForEiJob,
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
  const triggerInference = useStore((s) => s.triggerInference);
  const modelFilesRef = useRef<HTMLInputElement>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [eiProjects, setEiProjects] = useState<EiProject[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  /** Inline status shown directly inside the Inference card. The global
   * status bar lives at the bottom of the sidebar and is easy to miss when
   * the user is focused on this section, so we mirror progress + errors
   * here too. `kind: 'busy'` shows a spinner; 'ok'/'err' show a colored
   * message. */
  const [inferenceStatus, setInferenceStatus] = useState<{
    kind: 'idle' | 'busy' | 'ok' | 'err';
    msg: string;
  }>({ kind: 'idle', msg: '' });
  const setBoth = (kind: 'idle' | 'busy' | 'ok' | 'err', msg: string) => {
    setInferenceStatus({ kind, msg });
    if (kind !== 'idle') setStatus(kind, msg);
  };

  /** Translate raw fetch / runtime errors into something actionable. The
   * generic browser "TypeError: Failed to fetch" is opaque — usually means
   * either a CORS rejection or the user is offline; either way the user
   * deserves a hint about what to check. */
  const explainError = (e: unknown): string => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Failed to fetch|NetworkError|Load failed/.test(msg)) {
      return `Network/CORS error contacting the Edge Impulse Studio API. Check your network, that the API key is valid, and (production hosts only) that the page can reach studio.edgeimpulse.com without a CSP block. Original: ${msg}`;
    }
    if (/401/.test(msg)) return `${msg} — API key rejected. Double-check Dashboard → Keys in your project.`;
    if (/403/.test(msg)) return `${msg} — API key doesn't have access to this project.`;
    return msg;
  };

  const onListProjects = async () => {
    if (!ei.apiKey) {
      setBoth('err', 'Enter your Edge Impulse API key first');
      return;
    }
    setBoth('busy', 'Listing projects…');
    try {
      const list = await listEiProjects(ei.apiKey);
      setEiProjects(list);
      if (list.length === 0) {
        setBoth('err', 'No projects accessible to this API key');
      } else {
        if (list.length === 1) setSelectedProjectId(list[0].id);
        setBoth(
          'ok',
          `Found ${list.length} project${list.length === 1 ? '' : 's'}`,
        );
      }
    } catch (e) {
      setBoth('err', `List projects: ${explainError(e)}`);
    }
  };

  const onFetchModel = async () => {
    if (!ei.apiKey) {
      setBoth('err', 'Enter your Edge Impulse API key first');
      return;
    }
    if (!selectedProjectId) {
      setBoth('err', 'Pick a project first');
      return;
    }
    setModelLoading(true);
    try {
      setBoth('busy', 'Checking deployment history…');
      // Enumerate every successful build and pick the newest WebAssembly
      // (browser) one. This is the only API path that reliably finds the
      // deployment when the project has multiple impulses, engines, or
      // (engine, modelType) combinations — the legacy singular endpoint
      // requires the exact tuple up front and silently misses everything
      // else.
      const history = await listEiDeploymentHistory(
        ei.apiKey,
        selectedProjectId,
      );
      const isWasmBrowser = (e: (typeof history)[number]) => {
        const fmt = (e.deploymentFormat || '').toLowerCase();
        const targetFmt = (e.deploymentTarget?.format || '').toLowerCase();
        const targetName = (e.deploymentTarget?.name || '').toLowerCase();
        return (
          fmt === 'wasm' ||
          targetFmt === 'wasm' ||
          targetName.includes('webassembly') ||
          targetName.includes('browser')
        );
      };
      const candidate = history.find(
        (e) => isWasmBrowser(e) && !e.impulseIsDeleted,
      );
      if (!candidate) {
        if (history.length === 0) {
          setBoth(
            'err',
            'No deployments built yet. In the Studio: Deployment → Build with target "WebAssembly".',
          );
        } else {
          const formats = Array.from(
            new Set(
              history.map(
                (e) => e.deploymentTarget?.name || e.deploymentFormat || '?',
              ),
            ),
          ).join(', ');
          setBoth(
            'err',
            `No WebAssembly (browser) deployment found among ${history.length} build${
              history.length === 1 ? '' : 's'
            } (${formats}). In the Studio: Deployment → Build with target "WebAssembly".`,
          );
        }
        return;
      }
      setBoth(
        'busy',
        `Downloading model v${candidate.deploymentVersion} (${
          candidate.engine
        }${candidate.modelType ? `/${candidate.modelType}` : ''})…`,
      );
      const zip = await downloadEiHistoricDeployment(
        ei.apiKey,
        selectedProjectId,
        candidate.deploymentVersion,
      );
      setBoth('busy', `Unpacking model (${(zip.size / 1024).toFixed(0)} KB)…`);
      const projName =
        eiProjects?.find((p) => p.id === selectedProjectId)?.name ??
        `project-${selectedProjectId}`;
      const loaded = await loadEiModelFromZip(zip, projName);
      setEiModel(loaded, projName);
      const i = loaded.info;
      setBoth(
        'ok',
        `Loaded ${projName}: ${i.inputWidth}×${i.inputHeight} ${
          i.isRgb ? 'RGB' : 'GRAY'
        }${i.isObjectDetection ? ' · object detection' : ''}`,
      );
    } catch (e) {
      setBoth('err', `Fetch model: ${explainError(e)}`);
    } finally {
      setModelLoading(false);
    }
  };

  const onLoadModel = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const all = Array.from(files);
    const wasmFile = all.find((f) => f.name.toLowerCase().endsWith('.wasm')) ?? null;
    // Pick the .js intentionally: prefer edge-impulse-standalone.js, never
    // pick run-impulse.js (Node.js test wrapper that uses require()).
    const jsFiles = all.filter((f) => f.name.toLowerCase().endsWith('.js'));
    const jsFile =
      jsFiles.find((f) =>
        f.name.toLowerCase().includes('edge-impulse-standalone'),
      ) ??
      jsFiles.find(
        (f) => !/^run-impulse|^run-classifier|^index\.js$/i.test(f.name),
      ) ??
      jsFiles[0] ??
      null;
    if (!jsFile || !wasmFile) {
      setBoth(
        'err',
        'Pick BOTH the EI .js and .wasm from the unzipped WebAssembly deployment.',
      );
      return;
    }
    setModelLoading(true);
    setBoth('busy', `Loading model ${jsFile.name}…`);
    try {
      const loaded = await loadEiModel(jsFile, wasmFile, jsFile.name);
      setEiModel(loaded, jsFile.name.replace(/\.js$/i, ''));
      const i = loaded.info;
      setBoth(
        'ok',
        `Loaded ${jsFile.name}: ${i.inputWidth}×${i.inputHeight} ${
          i.isRgb ? 'RGB' : 'GRAY'
        }${i.isObjectDetection ? ' · object detection' : ''}${
          i.hasVisualAnomaly ? ' · visual anomaly' : ''
        }`,
      );
    } catch (e) {
      setBoth('err', `Model load: ${(e as Error).message}`);
    } finally {
      setModelLoading(false);
      if (modelFilesRef.current) modelFilesRef.current.value = '';
    }
  };

  const onUnloadModel = () => {
    setEiModel(null);
    setEiLive(false);
    setBoth('ok', 'Model unloaded');
  };

  /**
   * Kick off a fresh "WebAssembly (browser)" build via the EI Studio API,
   * poll until it finishes, then auto-fetch + load the result. Useful when
   * the user's project either has no deployment yet or the existing
   * deployment is the Node.js variant (which won't run here).
   */
  const onBuildBrowserDeployment = async () => {
    if (!ei.apiKey) {
      setBoth('err', 'Enter your Edge Impulse API key first');
      return;
    }
    if (!selectedProjectId) {
      setBoth('err', 'Pick a project first');
      return;
    }
    setModelLoading(true);
    try {
      setBoth('busy', 'Starting WebAssembly (browser) build…');
      const { jobId } = await buildEiDeployment(ei.apiKey, selectedProjectId);
      setBoth('busy', `Build job #${jobId} queued, waiting for it to finish…`);
      await waitForEiJob(ei.apiKey, selectedProjectId, jobId, {
        onProgress: (elapsed) => {
          setBoth(
            'busy',
            `Build job #${jobId} running (${Math.floor(elapsed / 1000)}s)…`,
          );
        },
      });
      setBoth('busy', 'Build done — downloading model…');
      // Look up the just-built artefact via the deployment history so we
      // download exactly that build (latest wasm entry).
      const history = await listEiDeploymentHistory(
        ei.apiKey,
        selectedProjectId,
      );
      const candidate = history.find((e) => {
        const fmt = (e.deploymentFormat || '').toLowerCase();
        const targetFmt = (e.deploymentTarget?.format || '').toLowerCase();
        const targetName = (e.deploymentTarget?.name || '').toLowerCase();
        return (
          fmt === 'wasm' ||
          targetFmt === 'wasm' ||
          targetName.includes('webassembly') ||
          targetName.includes('browser')
        );
      });
      if (!candidate) {
        throw new Error(
          'Build finished but no WebAssembly deployment shows up in history',
        );
      }
      const zip = await downloadEiHistoricDeployment(
        ei.apiKey,
        selectedProjectId,
        candidate.deploymentVersion,
      );
      const projName =
        eiProjects?.find((p) => p.id === selectedProjectId)?.name ??
        `project-${selectedProjectId}`;
      const loaded = await loadEiModelFromZip(zip, projName);
      setEiModel(loaded, projName);
      const i = loaded.info;
      setBoth(
        'ok',
        `Built & loaded ${projName}: ${i.inputWidth}×${i.inputHeight} ${
          i.isRgb ? 'RGB' : 'GRAY'
        }${i.isObjectDetection ? ' · object detection' : ''}`,
      );
    } catch (e) {
      setBoth('err', `Build deployment: ${explainError(e)}`);
    } finally {
      setModelLoading(false);
    }
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
          handle,
          isAnimated,
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
          handle,
          isAnimated,
          animationPlaying: isAnimated,
        });

        // Surface what we got so the user can debug Omniverse / usdzip
        // ingest issues without opening DevTools.
        const summary = `${meshCount} meshes · ${triangleCount.toLocaleString()} tris · ${maxDim.toFixed(2)}m max`;
        const matNote =
          defaultMaterialMeshes === 0
            ? ''
            : ` · ${defaultMaterialMeshes}/${meshCount} default-material${autoOverride ? ' (override auto-enabled)' : ''}`;
        const animNote = isAnimated ? ' · animated' : '';
        setStatus('ok', `Imported ${baseName}.usdz: ${summary}${matNote}${animNote}`);

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
    if (a) disposeUsdz(a.object, a.handle ?? undefined);
    removeAsset(id);
  };

  const onClearAssets = () => {
    for (const a of assets) disposeUsdz(a.object, a.handle ?? undefined);
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
      {
        mode,
        env_preset: envPreset,
        conveyor: showConveyor,
        conveyor_speed: showConveyor ? conveyorSpeed : undefined,
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

  const onRetrainModel = async () => {
    if (!ei.apiKey) {
      setStatus('err', 'Enter your Edge Impulse API key first');
      return;
    }

    let projectId = selectedProjectId;
    let projects = eiProjects;
    try {
      if (!projectId) {
        setStatus('busy', 'Finding Edge Impulse project…');
        projects = await listEiProjects(ei.apiKey);
        setEiProjects(projects);
        if (projects.length === 1) {
          projectId = projects[0].id;
          setSelectedProjectId(projectId);
        } else if (projects.length === 0) {
          setStatus('err', 'No projects accessible to this API key');
          return;
        } else {
          setStatus('err', 'Pick a project in the Inference card first');
          return;
        }
      }

      const projectName =
        projects?.find((p) => p.id === projectId)?.name ??
        `project-${projectId}`;
      setStatus('busy', `Starting retrain for ${projectName}…`);
      const { jobId } = await retrainEiModel(ei.apiKey, projectId);
      await waitForEiJob(ei.apiKey, projectId, jobId, {
        onProgress: (elapsed) => {
          setStatus(
            'busy',
            `Retrain job #${jobId} running (${Math.floor(elapsed / 1000)}s)…`,
          );
        },
      });
      setStatus(
        'ok',
        `Retrained ${projectName}. Build a browser deployment to refresh the in-browser model.`,
      );
    } catch (e) {
      setStatus('err', `Retrain model: ${explainError(e)}`);
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
                      {a.isAnimated ? ' · 🎞️' : ''}
                    </span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {a.isAnimated && (
                        <button
                          onClick={() =>
                            updateAsset(a.id, {
                              animationPlaying: !a.animationPlaying,
                            })
                          }
                          title={a.animationPlaying ? 'Pause animation' : 'Play animation'}
                          style={{ padding: '2px 6px' }}
                        >
                          {a.animationPlaying ? '⏸' : '▶'}
                        </button>
                      )}
                      <button
                        onClick={() => onRemoveAsset(a.id)}
                        style={{ padding: '2px 6px' }}
                      >
                        ×
                      </button>
                    </div>
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
              Object detection (YOLO/MobileNet) and FOMO models are supported.
            </div>

            <fieldset className="ei-fetch-group">
              <legend>From your project</legend>
              <button
                onClick={onListProjects}
                disabled={
                  modelLoading ||
                  !ei.apiKey ||
                  inferenceStatus.kind === 'busy'
                }
                title={
                  !ei.apiKey
                    ? 'Set your API key in the Edge Impulse · auth card above'
                    : undefined
                }
              >
                {inferenceStatus.kind === 'busy' &&
                inferenceStatus.msg.startsWith('Listing')
                  ? '… listing'
                  : eiProjects
                    ? '↻ Refresh projects'
                    : '🔑 List projects'}
              </button>
            {eiProjects && eiProjects.length > 0 && (
              <>
                {/* Project API keys (the common case) only ever resolve to
                    a single project — no point rendering a 1-item picker.
                    Show the name as a static label instead. Multi-project
                    keys still get the dropdown. */}
                {eiProjects.length === 1 ? (
                  <div className="field">
                    <span className="field-label">Project</span>
                    <div className="ei-project-name">
                      {eiProjects[0].name}
                      {eiProjects[0].owner ? ` · ${eiProjects[0].owner}` : ''}
                    </div>
                  </div>
                ) : (
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
                )}
                {/* Build button stays first in the visual order (primary
                    recovery action when Fetch fails) but is rendered as
                    secondary so Fetch — the most common happy-path action
                    — keeps the eye-catching teal styling. */}
                <button
                  onClick={onBuildBrowserDeployment}
                  disabled={modelLoading || !selectedProjectId}
                  title="Trigger a fresh WebAssembly (browser) build in the Studio, then auto-load it. Use this if the existing deployment is Node.js-only or there isn't one yet."
                >
                  🔨 Build browser deployment
                </button>
                <button
                  onClick={onFetchModel}
                  disabled={modelLoading || !selectedProjectId}
                  className="primary"
                >
                  {modelLoading ? '… loading' : '⤓ Fetch & load model'}
                </button>
              </>
            )}
            </fieldset>

            <fieldset className="ei-fetch-group">
              <legend>From file</legend>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                Upload the <code>edge-impulse-standalone.js</code> +{' '}
                <code>.wasm</code> from an unzipped EI{' '}
                <strong>WebAssembly (browser)</strong> deployment.
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
            {/* Inline status sits BELOW the action buttons so the user sees
                the result of the click they just made without scrolling. */}
            {inferenceStatus.kind !== 'idle' && (
              <div
                className={`inline-status ${inferenceStatus.kind}`}
                role="status"
                aria-live="polite"
              >
                {inferenceStatus.kind === 'busy' && (
                  <span className="spinner" aria-hidden />
                )}
                <span>{inferenceStatus.msg}</span>
              </div>
            )}
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
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Detections appear as boxes on the virtual-camera preview in
              the bottom-left.
            </div>
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
            {inferenceStatus.kind !== 'idle' && (
              <div
                className={`inline-status ${inferenceStatus.kind}`}
                role="status"
                aria-live="polite"
              >
                {inferenceStatus.kind === 'busy' && (
                  <span className="spinner" aria-hidden />
                )}
                <span>{inferenceStatus.msg}</span>
              </div>
            )}
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
            Set your API key in the <strong>Edge Impulse · auth</strong> card.
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
        <button
          onClick={onRetrainModel}
          disabled={!ei.apiKey || status.kind === 'busy'}
          title="Retrain the selected project's current impulse with the last known Studio settings."
        >
          ↻ Retrain model
        </button>
      </div>
    </>
  );
}
