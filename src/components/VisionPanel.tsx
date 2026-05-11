import { useState } from 'react';
import { useStore } from '../store/useStore';
import {
  listEiProjects,
  retrainEiModel,
  uploadCaptures,
  waitForEiJob,
} from '../lib/edgeImpulse';
import { useNumberInput } from '../lib/useNumberInput';
import { disposeUsdz } from '../lib/usdz';
import {
  deleteCustomTexture,
  putCustomTexture,
  type TextureKind,
} from '../lib/textureStore';
import { EiAuthCard } from './EiAuthCard';
import { EiInferenceCard } from './EiInferenceCard';
import { ImportedAssetsCard } from './ImportedAssetsCard';
import { ObjectCaptureCard } from './ObjectCaptureCard';
import { RealismCard } from './RealismCard';
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
  /** Translate raw fetch / runtime errors into something actionable. */
  const explainError = (e: unknown): string => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Failed to fetch|NetworkError|Load failed/.test(msg)) {
      return `Network/CORS error contacting Edge Impulse Studio. Check network, API key, and CSP. Original: ${msg}`;
    }
    if (/401/.test(msg)) return `${msg} — API key rejected.`;
    if (/403/.test(msg)) return `${msg} — API key doesn't have access.`;
    return msg;
  };

  const onUpload = async () => {
    setStatus('busy', `Uploading 0/${captures.length}…`);
    const includeBoxes = mode === 'detection';
    const defaultLabel = mode === 'anomaly' ? anomalyLabel : ei.label;
    const realism = useStore.getState().realism;
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
        realism_mode: realism.mode,
        realism_intensity:
          realism.mode === 'off' ? 0 : realism.intensity,
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

  /**
   * Retrain whichever project this API key resolves to. With a project-
   * scoped key (the common case) the single project is unambiguous; if
   * the key sees multiple projects, the user has to retrain from the
   * Studio so they pick the right one.
   */
  const onRetrainModel = async () => {
    if (!ei.apiKey) {
      setStatus('err', 'Enter your Edge Impulse API key first');
      return;
    }
    try {
      setStatus('busy', 'Finding Edge Impulse project…');
      const projects = await listEiProjects(ei.apiKey);
      if (projects.length === 0) {
        setStatus('err', 'No projects accessible to this API key');
        return;
      }
      if (projects.length > 1) {
        setStatus(
          'err',
          'Multi-project API key — retrain from the Studio instead.',
        );
        return;
      }
      const { id: projectId, name: projectName } = projects[0];
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

      <RealismCard />

      <EiAuthCard />

      <EiInferenceCard previewSource="virtual-camera" />

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
