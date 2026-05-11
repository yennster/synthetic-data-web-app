import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
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
import { useNumberInput } from '../lib/useNumberInput';
import { disposeUsdz } from '../lib/usdz';
import {
  deleteCustomTexture,
  putCustomTexture,
  type TextureKind,
} from '../lib/textureStore';
import { EiAuthCard } from './EiAuthCard';
import { ImportedAssetsCard } from './ImportedAssetsCard';
import { ObjectCaptureCard } from './ObjectCaptureCard';
import { SceneObjectsCard } from './SceneObjectsCard';

export function VisionPanel() {
  const {
    mode,
    sceneObjects,
    removeSceneObject,
    showConveyor,
    setShowConveyor,
    conveyorSpeed,
    setConveyorSpeed,
    envPreset,
    setEnvPreset,
    customFloorTexture,
    setCustomFloorTexture,
    customWallTexture,
    setCustomWallTexture,
    assets,
    removeAsset,
    setPendingAssets,
    capture: cs,
    setCapture,
    captures,
    clearCaptures,
    triggerCapture,
    triggerBatch,
    anomalyLabel,
    setAnomalyLabel,
    ei,
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
  // Controlled number inputs that tolerate transient empty / partial
  // entries while the user is typing — see lib/useNumberInput for why.
  const widthInput = useNumberInput(
    cs.width,
    (n) => setCapture({ width: n }),
    { min: 64, max: 4096 },
  );
  const heightInput = useNumberInput(
    cs.height,
    (n) => setCapture({ height: n }),
    { min: 64, max: 4096 },
  );
  const batchCountInput = useNumberInput(
    cs.batchCount,
    (n) => setCapture({ batchCount: n }),
    { min: 1, max: 500 },
  );
  // Auto-expand the custom-texture section if the user already has one
  // uploaded — they probably want to see / clear it. Otherwise hide the
  // controls behind a single toggle so the Scene card stays compact.
  const [texturesOpen, setTexturesOpen] = useState(
    customFloorTexture !== null || customWallTexture !== null,
  );
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

  const visionObjects = sceneObjects.filter((o) => o.owner == null);
  const visionAssets = assets.filter((a) => a.owner == null);

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
        <button
          type="button"
          onClick={() => setTexturesOpen((b) => !b)}
          aria-expanded={texturesOpen}
          className="section-toggle"
        >
          <span>Custom textures</span>
          <span
            className="section-toggle-chevron"
            style={{ transform: texturesOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
            aria-hidden
          >
            ▸
          </span>
          {(customFloorTexture || customWallTexture) && !texturesOpen && (
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10,
                color: 'var(--accent)',
                fontWeight: 500,
              }}
            >
              {[customFloorTexture && 'floor', customWallTexture && 'wall']
                .filter(Boolean)
                .join(' + ')}
            </span>
          )}
        </button>
        {texturesOpen && (
          <>
            <p
              style={{
                margin: 0,
                fontSize: 11,
                lineHeight: 1.45,
                color: 'var(--muted)',
              }}
            >
              Drop in a tileable image (PNG, JPG, WebP, AVIF, or GIF). For
              best results use a seamless 512×512 to 2048×2048 texture —
              the floor tiles 4× and walls tile 2× across the scene.
            </p>
            <CustomTextureField
              kind="floor"
              label="Floor texture"
              meta={customFloorTexture}
              setMeta={setCustomFloorTexture}
              setStatus={setStatus}
            />
            <CustomTextureField
              kind="wall"
              label="Wall texture"
              meta={customWallTexture}
              setMeta={setCustomWallTexture}
              setStatus={setStatus}
            />
          </>
        )}
        <div className="webcam-control">
          <div className="webcam-control-copy">
            <div className="webcam-control-heading">
              <span className="webcam-control-title">Conveyor belt</span>
              <span
                className={`webcam-control-state ${
                  showConveyor ? 'on' : 'off'
                }`}
              >
                {showConveyor ? 'On' : 'Off'}
              </span>
            </div>
            <div className="webcam-control-help">
              {showConveyor
                ? 'Spawned objects ride the belt — adjust speed below.'
                : 'No belt — objects fall onto the floor at spawn position.'}
            </div>
          </div>
          <button
            type="button"
            className={`webcam-switch ${showConveyor ? 'on' : ''}`}
            role="switch"
            aria-checked={showConveyor}
            aria-label={
              showConveyor ? 'Turn conveyor belt off' : 'Turn conveyor belt on'
            }
            onClick={() => setShowConveyor(!showConveyor)}
          >
            <span className="webcam-switch-thumb" />
          </button>
        </div>
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
        <button
          onClick={() => {
            const textureCount =
              (customFloorTexture ? 1 : 0) + (customWallTexture ? 1 : 0);
            const total =
              visionObjects.length + visionAssets.length + textureCount;
            if (total === 0) return;
            const parts = [
              `${visionObjects.length} object(s)`,
              `${visionAssets.length} imported asset(s)`,
            ];
            if (textureCount) parts.push(`${textureCount} custom texture(s)`);
            const ok = window.confirm(
              `Reset scene? This removes ${parts.join(', ')} from this session and from saved storage.`,
            );
            if (!ok) return;
            for (const a of visionAssets) {
              disposeUsdz(a.object, a.handle ?? undefined);
              removeAsset(a.id);
            }
            for (const o of visionObjects) removeSceneObject(o.id);
            // Drop any pending-rehydrate metadata too. Edge case: user hits
            // Reset while the rehydrate hook is still walking pendingAssets;
            // without this it would re-add the asset we just cleared.
            setPendingAssets(
              useStore
                .getState()
                .pendingAssets.filter((a) => a.owner != null),
            );
            setEnvPreset('studio');
            // Also drop any user-uploaded floor/wall textures — the reset
            // takes the scene all the way back to studio defaults.
            setCustomFloorTexture(null);
            setCustomWallTexture(null);
            void deleteCustomTexture('floor').catch(() => {});
            void deleteCustomTexture('wall').catch(() => {});
            setStatus('ok', 'Scene reset');
          }}
          disabled={
            visionObjects.length === 0 &&
            visionAssets.length === 0 &&
            !customFloorTexture &&
            !customWallTexture
          }
          style={{ marginTop: 4 }}
        >
          Reset scene
        </button>
      </div>

      <SceneObjectsCard ownerFilter="vision" />

      <ImportedAssetsCard ownerFilter="vision" />

      <ObjectCaptureCard />

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
              {...widthInput.inputProps}
            />
          </label>
          <label className="field">
            Height
            <input
              type="number"
              min={64}
              max={2048}
              step={32}
              {...heightInput.inputProps}
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
                {...batchCountInput.inputProps}
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

/**
 * File picker + clear control for a single custom surface texture
 * (floor or wall). Writes the original image bytes to IndexedDB and
 * stores just the file name in the persisted store, so the texture
 * survives reloads without bloating localStorage.
 */
function CustomTextureField({
  kind,
  label,
  meta,
  setMeta,
  setStatus,
}: {
  kind: TextureKind;
  label: string;
  meta: { name: string } | null;
  setMeta: (m: { name: string } | null) => void;
  setStatus: (
    kind: 'idle' | 'ok' | 'err' | 'busy',
    msg: string,
  ) => void;
}) {
  return (
    <label className="field">
      {label}
      <div className="row">
        <input
          type="file"
          accept="image/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              await putCustomTexture(kind, file);
              setMeta({ name: file.name });
              setStatus('ok', `${label}: ${file.name}`);
            } catch (err) {
              setStatus(
                'err',
                `${label} upload failed: ${(err as Error).message}`,
              );
            }
            // Reset the input so picking the same file again still fires
            // onChange (browsers skip the event if value didn't change).
            e.target.value = '';
          }}
          style={{ fontSize: 11, flex: 1 }}
        />
        {meta && (
          <button
            onClick={() => {
              setMeta(null);
              void deleteCustomTexture(kind).catch(() => {});
              setStatus('ok', `${label} cleared`);
            }}
            title={`Remove custom ${kind} texture`}
          >
            Clear
          </button>
        )}
      </div>
      {meta && (
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>
          Using: {meta.name}
        </span>
      )}
    </label>
  );
}
