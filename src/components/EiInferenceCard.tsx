import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import {
  buildEiDeployment,
  downloadEiHistoricDeployment,
  listEiDeploymentHistory,
  listEiProjects,
  waitForEiJob,
  type EiProject,
} from '../lib/edgeImpulse';
import { loadEiModel, loadEiModelFromZip } from '../lib/eiModel';

/**
 * Edge Impulse model picker, loader, and live-inference controller.
 * Shared by detection/anomaly mode (against the virtual camera) and
 * robotics mode (against the rover/arm POV camera). The component is
 * UI + status orchestration only — the actual inference runs in the
 * camera component (`VirtualCamera` / `RobotPovCamera`) on its own
 * timer, reading `eiModel` + `eiLive` straight from the store.
 *
 * `previewSource` only affects the help-text describing where the
 * detection boxes will render so users in each mode get a hint that
 * matches their on-screen preview.
 */
export function EiInferenceCard({
  previewSource,
}: {
  previewSource: 'virtual-camera' | 'robot-pov';
}) {
  const ei = useStore((s) => s.ei);
  const setStatus = useStore((s) => s.setStatus);
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
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(
    null,
  );
  const lastApiKeyRef = useRef(ei.apiKey);
  const [inferenceStatus, setInferenceStatus] = useState<{
    kind: 'idle' | 'busy' | 'ok' | 'err';
    msg: string;
  }>({ kind: 'idle', msg: '' });
  const setBoth = (kind: 'idle' | 'busy' | 'ok' | 'err', msg: string) => {
    setInferenceStatus({ kind, msg });
    if (kind !== 'idle') setStatus(kind, msg);
  };

  useEffect(() => {
    if (ei.apiKey === lastApiKeyRef.current) return;
    lastApiKeyRef.current = ei.apiKey;
    setEiProjects(null);
    setSelectedProjectId(null);
  }, [ei.apiKey]);

  const explainError = (e: unknown): string => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Failed to fetch|NetworkError|Load failed/.test(msg)) {
      return `Network/CORS error contacting the Edge Impulse Studio API. Check your network, that the API key is valid, and (production hosts only) that the page can reach studio.edgeimpulse.com without a CSP block. Original: ${msg}`;
    }
    if (/401/.test(msg))
      return `${msg} — API key rejected. Double-check Dashboard → Keys in your project.`;
    if (/403/.test(msg))
      return `${msg} — API key doesn't have access to this project.`;
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
      const nextProjectId =
        list.length === 1
          ? list[0].id
          : list.some((p) => p.id === selectedProjectId)
            ? selectedProjectId
            : null;
      setSelectedProjectId(nextProjectId);
      if (list.length === 0) {
        setBoth('err', 'No projects accessible to this API key');
      } else {
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
    const wasmFile =
      all.find((f) => f.name.toLowerCase().endsWith('.wasm')) ?? null;
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

  const previewHint =
    previewSource === 'robot-pov'
      ? 'Detections appear as boxes on the Robot POV preview in the bottom-left.'
      : 'Detections appear as boxes on the virtual-camera preview in the bottom-left.';

  return (
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
            {previewHint}
          </div>
          {eiResult && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {eiResult.bounding_boxes.length} boxes
              {eiResult.classification.length > 0 &&
                ` · top: ${(() => {
                  const top = [...eiResult.classification].sort(
                    (a, b) => b.value - a.value,
                  )[0];
                  return top
                    ? `${top.label} ${(top.value * 100).toFixed(0)}%`
                    : '';
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
  );
}
