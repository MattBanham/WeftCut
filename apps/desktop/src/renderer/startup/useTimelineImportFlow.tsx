import { open as openDialog } from "@/bridge/dialog";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppDialog } from "../components/AppDialog";
import { AppSelect } from "../components/AppSelect";
import { Button } from "@/components/ui/button";
import {
  projectDiscardTimelinePreview,
  projectListTimelineSequences,
  projectImportTimeline,
  projectPreviewTimeline,
} from "../ipc";
import type { TimelineImportPreview, TimelineSequenceChoice } from "../../shared/timelineImport";
import { fpsLabel } from "./canvasPresets";
import { cleanIpcDetail } from "./openError";

export function useTimelineImportFlow() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timelinePreview, setTimelinePreview] = useState<TimelineImportPreview | null>(null);
  const [relinkRequest, setRelinkRequest] = useState<{ source: string; sequenceIndex?: number | undefined } | null>(null);
  const [sequenceImport, setSequenceImport] = useState<{ source: string; choices: TimelineSequenceChoice[] } | null>(null);

  const begin = useCallback(async () => {
    if (busy || sequenceImport !== null || timelinePreview !== null) return;
    setBusy(true);
    setError(null);

    setRelinkRequest(null);
    try {
      const source = await openDialog({
        title: t("startup.import_timeline_title"),
        filters: [{ name: "Timeline interchange", extensions: ["fcpxml", "fcpxmld"] }],
        allowDirectories: true,
      });
      if (typeof source !== "string") return;
      {
        const choices = await projectListTimelineSequences(source);
        if (choices.length > 1) {
          setSequenceImport({ source, choices });
          return;
        }
      }
      const sequenceIndex = 0;

      {
        try { setTimelinePreview(await projectPreviewTimeline(source, undefined, sequenceIndex)); }
        catch (cause) {
          if (cleanIpcDetail(cause).includes("Missing or unreadable original media")) {
            setRelinkRequest({ source, sequenceIndex });
          }
          throw cause;
        }
      }
    } catch (cause) {
      const message = t("startup.import_timeline_failed", { detail: cleanIpcDetail(cause) });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, sequenceImport, timelinePreview, t]);

  const relink = useCallback(async () => {
    if (!relinkRequest || busy) return;
    const folder = await openDialog({ title: t("startup.import_choose_relink_folder"), directory: true });
    if (typeof folder !== "string") return;
    setBusy(true);
    setError(null);

    try {
      const preview = await projectPreviewTimeline(
        relinkRequest.source, folder, relinkRequest.sequenceIndex,
      );

      setTimelinePreview(preview);
      setRelinkRequest(null);
    } catch (cause) {
      const message = t("startup.import_timeline_failed", { detail: cleanIpcDetail(cause) });
      setError(message);
    } finally { setBusy(false); }
  }, [relinkRequest, busy, t]);

  const chooseSequence = useCallback(async (index: number) => {
    if (!sequenceImport || busy) return;
    const { source } = sequenceImport;
    setBusy(true);
    setError(null);

    try {

      try {
        const preview = await projectPreviewTimeline(source, undefined, index);
        setTimelinePreview(preview);
        setSequenceImport(null);
      } catch (cause) {
        if (cleanIpcDetail(cause).includes("Missing or unreadable original media")) {
          setRelinkRequest({ source, sequenceIndex: index });
          setSequenceImport(null);
        }
        throw cause;
      }
    } catch (cause) {
      const message = t("startup.import_timeline_failed", { detail: cleanIpcDetail(cause) });
      setError(message);
    } finally { setBusy(false); }
  }, [sequenceImport, busy, t]);

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
      {timelinePreview && (
        <TimelineImportReview
          preview={timelinePreview}
          onCancel={() => {
            void projectDiscardTimelinePreview(timelinePreview.id).catch(() => {});
            setTimelinePreview(null);
          }}
          onImport={async (canvas) => {
            await projectImportTimeline(timelinePreview.id, canvas);
            setTimelinePreview(null);
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

function TimelineImportReview({ preview, onImport, onCancel }: {
  preview: TimelineImportPreview;
  onImport: (canvas: 'fit' | 'fill' | 'original') => Promise<void>;
  onCancel: () => void;
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
        {preview.compatibilityItems.map((item, i) => (
          <p key={i} title={item.location}>
            {item.label} (lane {item.lane}) — {t("startup.timeline_review_status_" + item.status)}
            {item.notes.length > 0 ? ': ' + item.notes.join('; ') : ''}
          </p>
        ))}
      </section>
      {preview.videoConversions.length > 0 && (
        <section aria-label={t("startup.timeline_review_video_sources")}>
          <p><strong>{t("startup.timeline_review_video_sources")}</strong></p>
          {preview.videoConversions.map((source) => (
            <p key={source.source} title={source.source}>
              {source.source.split(/[\\/]/).pop()} — {source.sourceWidth} × {source.sourceHeight},
              {' '}{fpsLabel(source.sourceFps, t)}
              {source.rateConformed ? ' → ' + fpsLabel(preview.fps, t) : ''}
              {source.pixelAspect ? ' · SAR ' + source.pixelAspect.h + ':' + source.pixelAspect.v : ''}
              {source.scaledToFit ? ' · ' + t("startup.timeline_review_video_mode_" + source.spatialConform) : ''}
            </p>
          ))}
        </section>
      )}
      {preview.resampledAudioClips > 0 && <p role="status">{t("startup.timeline_review_audio_resample", { count: preview.resampledAudioClips })}</p>}
      {preview.downmixedAudioClips > 0 && <p role="status">{t("startup.timeline_review_audio_downmix", { count: preview.downmixedAudioClips })}</p>}
      {error && <p className="new-project-error" role="alert">{error}</p>}
      <footer className="new-project-actions">
        <Button size="lg" onClick={onCancel} disabled={busy}>{t("new_project.cancel")}</Button>
        <Button size="lg" onClick={submit} disabled={busy || error !== null || fpsMismatch}>
          {t(busy ? "startup.import_timeline_busy" : "startup.import_timeline_submit")}
        </Button>
      </footer>
    </AppDialog>
  );
}
