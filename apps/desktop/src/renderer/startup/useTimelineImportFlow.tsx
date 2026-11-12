import { open as openDialog, save as saveDialog } from "@/bridge/dialog";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppSelect } from "../components/AppSelect";
import { Button } from "@/components/ui/button";
import {
  projectDiscardTimelinePreview,
  projectListTimelineSequences,
  projectImportTimeline,
  projectPreviewTimeline,
} from "../ipc";
import type { EdlImportOptions, TimelineImportPreview, TimelineSequenceChoice } from "../../shared/timelineImport";
import { FPS_OPTIONS, fpsLabel } from "./canvasPresets";
import { cleanIpcDetail } from "./openError";

// The start screen and File menu share review and validation. In-project
// imports use one Group, leaving the existing clips untouched.
export function useTimelineImportFlow(onImported: () => void, onError?: (message: string | null) => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edlImport, setEdlImport] = useState<{ source: string; destination: string; mode: 'new' | 'current' } | null>(null);
  const [timelinePreview, setTimelinePreview] = useState<TimelineImportPreview | null>(null);
  const [sourceFile, setSourceFile] = useState<{ path: string; edl?: EdlImportOptions; relinkDirectory?: string; sequenceIndex?: number | undefined } | null>(null);
  const [relinkRequest, setRelinkRequest] = useState<{ source: string; destination: string; mode: 'new' | 'current'; sequenceIndex?: number | undefined } | null>(null);
  const [sequenceImport, setSequenceImport] = useState<{ source: string; mode: 'new' | 'current'; choices: TimelineSequenceChoice[] } | null>(null);

  const begin = useCallback(async (mode: 'new' | 'current' = 'new') => {
    if (busy || edlImport !== null || sequenceImport !== null || timelinePreview !== null) return;
    setBusy(true);
    setError(null);
    onError?.(null);
    setRelinkRequest(null);
    try {
      const source = await openDialog({
        title: t("startup.import_timeline_title"),
        filters: [{ name: "Timeline interchange", extensions: ["fcpxml", "fcpxmld", "edl"] }],
        allowDirectories: true,
      });
      if (typeof source !== "string") return;
      const isEdl = /\.edl$/i.test(source);
      if (!isEdl) {
        const choices = await projectListTimelineSequences(source);
        if (choices.length > 1) {
          setSequenceImport({ source, mode, choices });
          return;
        }
      }
      const sequenceIndex = isEdl ? undefined : 0;
      setSourceFile({ path: source, sequenceIndex });
      const name = source.split(/[\/]/).pop()!.replace(/\.(fcpxml|fcpxmld|edl)$/i, "");
      const destination = mode === 'new' ? await saveDialog({
        title: t("startup.import_timeline_destination"),
        defaultPath: t("startup.import_timeline_folder", { name }),
      }) : '';
      if (destination === null) return;
      if (isEdl) setEdlImport({ source, destination, mode });
      else {
        try { setTimelinePreview(await projectPreviewTimeline(source, destination, undefined, mode, undefined, sequenceIndex)); }
        catch (cause) {
          if (cleanIpcDetail(cause).includes("Missing or unreadable original media")) {
            setRelinkRequest({ source, destination, mode, sequenceIndex });
          }
          throw cause;
        }
      }
    } catch (cause) {
      const message = t("startup.import_timeline_failed", { detail: cleanIpcDetail(cause) });
      if (onError) onError(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, edlImport, sequenceImport, timelinePreview, t, onError]);

  const relink = useCallback(async () => {
    if (!relinkRequest || busy) return;
    const folder = await openDialog({ title: t("startup.import_choose_relink_folder"), directory: true });
    if (typeof folder !== "string") return;
    setBusy(true);
    setError(null);
    onError?.(null);
    try {
      const preview = await projectPreviewTimeline(
        relinkRequest.source, relinkRequest.destination, undefined, relinkRequest.mode, folder, relinkRequest.sequenceIndex,
      );
      setSourceFile({ path: relinkRequest.source, relinkDirectory: folder, sequenceIndex: relinkRequest.sequenceIndex });
      setTimelinePreview(preview);
      setRelinkRequest(null);
    } catch (cause) {
      const message = t("startup.import_timeline_failed", { detail: cleanIpcDetail(cause) });
      if (onError) onError(message);
      else setError(message);
    } finally { setBusy(false); }
  }, [relinkRequest, busy, t, onError]);

  const chooseSequence = useCallback(async (index: number) => {
    if (!sequenceImport || busy) return;
    const { source, mode } = sequenceImport;
    setBusy(true);
    setError(null);
    onError?.(null);
    try {
      const name = sequenceImport.choices[index]?.name ?? source.split(/[\\/]/).pop()!.replace(/\.(fcpxml|fcpxmld)$/i, "");
      const destination = mode === 'new' ? await saveDialog({
        title: t("startup.import_timeline_destination"),
        defaultPath: t("startup.import_timeline_folder", { name }),
      }) : '';
      if (destination === null) return;
      setSourceFile({ path: source, sequenceIndex: index });
      try {
        const preview = await projectPreviewTimeline(source, destination, undefined, mode, undefined, index);
        setTimelinePreview(preview);
        setSequenceImport(null);
      } catch (cause) {
        if (cleanIpcDetail(cause).includes("Missing or unreadable original media")) {
          setRelinkRequest({ source, destination, mode, sequenceIndex: index });
          setSequenceImport(null);
        }
        throw cause;
      }
    } catch (cause) {
      const message = t("startup.import_timeline_failed", { detail: cleanIpcDetail(cause) });
      if (onError) onError(message);
      else setError(message);
    } finally { setBusy(false); }
  }, [sequenceImport, busy, t, onError]);

  const dialogs = (
    <>
      {error && (
        <AppDialog title={t("startup.import_timeline_title")} onClose={() => setError(null)} panelClassName="new-project-panel">
          <p className="new-project-error" role="alert">{error}</p>
          <footer className="new-project-actions">
            <Button onClick={() => setError(null)}>{t("new_project.cancel")}</Button>
            {relinkRequest && <Button onClick={() => void relink()} disabled={busy}>
              {t("startup.import_choose_relink_folder")}
            </Button>}
          </footer>
        </AppDialog>
      )}
      {sequenceImport && (
        <TimelineSequencePicker
          choices={sequenceImport.choices}
          busy={busy}
          onCancel={() => setSequenceImport(null)}
          onChoose={chooseSequence}
        />
      )}
      {edlImport && (
        <EdlImportForm
          onCancel={() => setEdlImport(null)}
          onImport={async (options) => {
            setSourceFile({ path: edlImport.source, edl: options });
            const preview = await projectPreviewTimeline(edlImport.source, edlImport.destination, options, edlImport.mode);
            setEdlImport(null);
            setTimelinePreview(preview);
          }}
        />
      )}
      {timelinePreview && (
        <TimelineImportReview
          preview={timelinePreview}
          onNewProject={async () => {
            if (!sourceFile) throw new Error('Choose a timeline source again');
            const name = sourceFile.path.split(/[\\/]/).pop()!.replace(/\.(fcpxml|fcpxmld|edl)$/i, '');
            const destination = await saveDialog({
              title: t('startup.import_timeline_destination'),
              defaultPath: t('startup.import_timeline_folder', { name }),
            });
            if (!destination) return;
            const next = await projectPreviewTimeline(sourceFile.path, destination, sourceFile.edl, 'new', sourceFile.relinkDirectory, sourceFile.sequenceIndex);
            setTimelinePreview(next);
          }}
          onCancel={() => {
            void projectDiscardTimelinePreview(timelinePreview.id).catch(() => {});
            setTimelinePreview(null);
          }}
          onImport={async (canvas) => {
            await projectImportTimeline(timelinePreview.id, canvas);
            const wasNewProject = timelinePreview.mode === 'new';
            setTimelinePreview(null);
            if (wasNewProject) onImported();
          }}
        />
      )}
    </>
  );
  return { begin, relink, canRelink: relinkRequest !== null, busy, dialogs };
}

function TimelineSequencePicker({ choices, busy, onCancel, onChoose }: {
  choices: TimelineSequenceChoice[];
  busy: boolean;
  onCancel: () => void;
  onChoose: (index: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(String(choices[0]!.index));
  return (
    <AppDialog title={t("startup.import_select_sequence_title")} onClose={busy ? undefined : onCancel} panelClassName="new-project-panel">
      <p>{t("startup.import_select_sequence_hint", { count: choices.length })}</p>
      <AppSelect
        ariaLabel={t("startup.import_select_sequence_label")}
        value={index}
        onValueChange={setIndex}
        options={choices.map(c => ({
          value: String(c.index),
          label: c.event ? `${c.event} / ${c.name} (#${c.index + 1})` : `${c.name} (#${c.index + 1})`,
        }))}
      />
      <p className="new-project-preview">{choices[Number(index)]?.location}</p>
      <footer className="new-project-actions">
        <Button size="lg" onClick={onCancel} disabled={busy}>{t("new_project.cancel")}</Button>
        <Button size="lg" onClick={() => void onChoose(Number(index))} disabled={busy}>
          {t("startup.import_select_sequence_continue")}
        </Button>
      </footer>
    </AppDialog>
  );
}

function TimelineImportReview({ preview, onImport, onCancel, onNewProject }: {
  preview: TimelineImportPreview;
  onImport: (canvas: 'fit' | 'fill' | 'original') => Promise<void>;
  onCancel: () => void;
  onNewProject: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<'fit' | 'fill' | 'original'>('fit');
  const current = preview.current;
  const fpsMismatch = current != null &&
    current.fps.num * preview.fps.den !== preview.fps.num * current.fps.den;
  const sizeMismatch = current != null &&
    (current.width !== preview.width || current.height !== preview.height);

  async function chooseNew() {
    setBusy(true);
    try { await onNewProject(); }
    catch (cause) { setError(cleanIpcDetail(cause)); }
    finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true);
    try { await onImport(canvas); }
    catch (cause) {
      setError(cleanIpcDetail(cause));
      setBusy(false);
    }
  }

  return (
    <AppDialog title={t("startup.timeline_review")} onClose={busy ? undefined : onCancel} panelClassName="new-project-panel">
      <p>{preview.name}</p>
      <p className="new-project-preview" title={preview.destination}>{preview.destination}</p>
      <p>{t("startup.timeline_review_format", {
        width: preview.width, height: preview.height, rate: fpsLabel(preview.fps, t), frames: preview.durationFrames,
      })}</p>
      <p>{t("startup.timeline_review_contents", {
        video: preview.videoClips, audio: preview.audioClips, markers: preview.markers, media: preview.media,
      })}</p>
      {preview.connectedClips > 0 && (
        <>
          <p>{t("startup.timeline_review_lanes", { lanes: preview.lanes.join(", ") })}</p>
          <p>{t("startup.timeline_review_connections", { count: preview.connectedClips })}</p>
          {(preview.lanes.length > 2 || preview.lanes.some((lane) => lane < 0)) &&
            <p>{t("startup.timeline_review_all_tracks")}</p>}
        </>
      )}
      {current && (
        <section aria-label={t("startup.import_conflicts_title")}>
          <p><strong>{t("startup.import_conflicts_title")}</strong></p>
          <p>{t("startup.import_existing_group_hint")}</p>
          <p>{t("startup.import_conflict_fps", {
            current: fpsLabel(current.fps, t), imported: fpsLabel(preview.fps, t),
          })}</p>
          {fpsMismatch ? (
            <p className="new-project-error" role="alert">{t("startup.import_fps_unsupported")}</p>
          ) : <p>{t("startup.import_fps_match")}</p>}
          <p>{t("startup.import_conflict_size", {
            current: current.width + " × " + current.height,
            imported: preview.width + " × " + preview.height,
          })}</p>
          {sizeMismatch && (
            <div className="new-project-row">
              <span>{t("startup.import_canvas_choice")}</span>
              <AppSelect
                ariaLabel={t("startup.import_canvas_choice")}
                value={canvas}
                onValueChange={(v) => setCanvas(v as 'fit' | 'fill' | 'original')}
                options={[
                  { value: 'fit', label: t("startup.import_canvas_fit") },
                  { value: 'fill', label: t("startup.import_canvas_fill") },
                  { value: 'original', label: t("startup.import_canvas_original") },
                ]}
              />
            </div>
          )}
          <p>{t("startup.import_audio_choice", {
            current: current.sampleRate / 1000 + " kHz / " + current.channels,
            imported: "48 kHz / stereo",
          })}</p>
        </section>
      )}
      {preview.namedFormatDefaults && <p role="status">{t("startup.timeline_review_named_format")}</p>}
      {preview.normalizedTimecode && <p role="status">{t("startup.timeline_review_timecode_origin")}</p>}
      {preview.dropFrameTimecode && <p role="status">{t("startup.timeline_review_timecode_df")}</p>}
      {preview.bundleSource && <p role="status">{t("startup.timeline_review_bundle")}</p>}
      {preview.relinkedMedia.length > 0 && (
        <section aria-label={t("startup.import_relinked_media")}>
          <p><strong>{t("startup.import_relinked_media")}</strong></p>
          {preview.relinkedMedia.map(({ from, to }) => (
            <p key={from} className="new-project-preview" title={from + " → " + to}>
              {from} → {to}
            </p>
          ))}
        </section>
      )}
      {preview.roundedEnds > 0 && <p>{t("startup.timeline_review_rounding")}</p>}
      {preview.rateConformedVideoClips > 0 && <p role="status">{t("startup.timeline_review_fps_conform", { count: preview.rateConformedVideoClips })}</p>}
      {preview.resizedVideoClips > 0 && <p role="status">{t("startup.timeline_review_video_fit", { count: preview.resizedVideoClips })}</p>}
      <section aria-label={t("startup.timeline_review_compatibility_title")}>
        <p><strong>{t("startup.timeline_review_compatibility_title")}</strong></p>
        <p>{t("startup.timeline_review_compatibility_counts", preview.compatibilityCounts)}</p>
        <p>{t("startup.timeline_review_unsupported_policy")}</p>
        {preview.compatibilityItems.slice(0, 12).map((item, i) => (
          <p key={i} title={item.location}>
            {item.label} (lane {item.lane}) — {t("startup.timeline_review_status_" + item.status)}
            {item.notes.length > 0 ? ': ' + item.notes.join('; ') : ''}
          </p>
        ))}
        {preview.compatibilityItems.length > 12 && (
          <p>{t("startup.timeline_review_more_sources", { count: preview.compatibilityItems.length - 12 })}</p>
        )}
      </section>
      {preview.videoConversions.length > 0 && (
        <section aria-label={t("startup.timeline_review_video_sources")}>
          <p><strong>{t("startup.timeline_review_video_sources")}</strong></p>
          {preview.videoConversions.slice(0, 8).map((source) => (
            <p key={source.source} title={source.source}>
              {source.source.split(/[\\/]/).pop()} — {source.sourceWidth} × {source.sourceHeight},
              {' '}{fpsLabel(source.sourceFps, t)}
              {source.rateConformed ? ' → ' + fpsLabel(preview.fps, t) : ''}
              {source.pixelAspect ? ' · SAR ' + source.pixelAspect.h + ':' + source.pixelAspect.v : ''}
              {source.scaledToFit ? ' · ' + t("startup.timeline_review_video_mode_" + source.spatialConform) : ''}
            </p>
          ))}
          {preview.videoConversions.length > 8 &&
            <p>{t("startup.timeline_review_more_sources", { count: preview.videoConversions.length - 8 })}</p>}
        </section>
      )}
      {preview.resampledAudioClips > 0 && <p role="status">{t("startup.timeline_review_audio_resample", { count: preview.resampledAudioClips })}</p>}
      {preview.downmixedAudioClips > 0 && <p role="status">{t("startup.timeline_review_audio_downmix", { count: preview.downmixedAudioClips })}</p>}
      {error && <p className="new-project-error" role="alert">{error}</p>}
      <footer className="new-project-actions">
        <Button size="lg" onClick={onCancel} disabled={busy}>{t("new_project.cancel")}</Button>
        {current && <Button size="lg" onClick={() => void chooseNew()} disabled={busy}>
          {t("startup.import_use_new_project")}
        </Button>}
        <Button size="lg" onClick={submit} disabled={busy || error !== null || fpsMismatch}>
          {t(busy ? "startup.import_timeline_busy" : "startup.import_timeline_submit")}
        </Button>
      </footer>
    </AppDialog>
  );
}

function EdlImportForm({ onImport, onCancel }: {
  onImport: (options: EdlImportOptions) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [fps, setFps] = useState("");
  const [recordOrigin, setRecordOrigin] = useState("");
  const [sourceOrigin, setSourceOrigin] = useState("");
  const [mediaDirectory, setMediaDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timecode = /^\d\d:[0-5]\d:[0-5]\d:\d\d$/;
  const canImport = !busy && fps !== "" && mediaDirectory !== "" && timecode.test(recordOrigin) && timecode.test(sourceOrigin);

  async function pickMedia() {
    const dir = await openDialog({ title: t("startup.edl_media_folder"), directory: true });
    if (typeof dir === "string") setMediaDirectory(dir);
  }

  async function submit() {
    if (!canImport) return;
    const [fpsNum, fpsDen] = fps.split("/").map(Number);
    setBusy(true);
    setError(null);
    try { await onImport({ fpsNum: fpsNum!, fpsDen: fpsDen!, recordOrigin, sourceOrigin, mediaDirectory }); }
    catch (cause) { setError(cleanIpcDetail(cause)); setBusy(false); }
  }

  return (
    <AppDialog title={t("startup.edl_title")} onClose={busy ? undefined : onCancel} panelClassName="new-project-panel">
      <p>{t("startup.edl_description")}</p>
      <div className="new-project-row">
        <span>{t("new_project.frame_rate")}</span>
        <AppSelect
          ariaLabel={t("new_project.frame_rate")}
          value={fps}
          onValueChange={setFps}
          disabled={busy}
          options={[
            { value: "", label: t("startup.edl_choose_rate"), disabled: true },
            ...FPS_OPTIONS.map((rate) => ({ value: rate.num + "/" + rate.den, label: fpsLabel(rate, t) })),
          ]}
        />
      </div>
      <label className="new-project-row">
        <span>{t("startup.edl_record_origin")}</span>
        <AppInput mono value={recordOrigin} onValueChange={setRecordOrigin} disabled={busy} placeholder="00:00:00:00" maxLength={11} />
      </label>
      <label className="new-project-row">
        <span>{t("startup.edl_source_origin")}</span>
        <AppInput mono value={sourceOrigin} onValueChange={setSourceOrigin} disabled={busy} placeholder="00:00:00:00" maxLength={11} />
      </label>
      <div className="new-project-row">
        <span>{t("startup.edl_media_folder")}</span>
        <div className="new-project-folder">
          <span className="new-project-folder-path" title={mediaDirectory}>
            {mediaDirectory || t("new_project.parent_folder_placeholder")}
          </span>
          <Button onClick={pickMedia} disabled={busy}>{t("new_project.choose_folder")}</Button>
        </div>
      </div>
      {error && <p className="new-project-error" role="alert">{error}</p>}
      <footer className="new-project-actions">
        <Button size="lg" onClick={onCancel} disabled={busy}>{t("new_project.cancel")}</Button>
        <Button size="lg" onClick={submit} disabled={!canImport}>
          {t(busy ? "startup.timeline_review_preparing" : "startup.timeline_review_continue")}
        </Button>
      </footer>
    </AppDialog>
  );
}
