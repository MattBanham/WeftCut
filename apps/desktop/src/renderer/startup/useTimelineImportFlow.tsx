import { open as openDialog, save as saveDialog } from "@/bridge/dialog";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppSelect } from "../components/AppSelect";
import { Button } from "@/components/ui/button";
import {
  projectDiscardTimelinePreview,
  projectImportTimeline,
  projectPreviewTimeline,
} from "../ipc";
import type { EdlImportOptions, TimelineImportPreview } from "../../shared/timelineImport";
import { FPS_OPTIONS, fpsLabel } from "./canvasPresets";
import { cleanIpcDetail } from "./openError";

// Both the start screen and the in-editor File menu use one review-and-publish
// flow. Imports always create a separate project; a project's current edit is
// never silently overwritten or merged.
export function useTimelineImportFlow(onImported: () => void, onError?: (message: string | null) => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edlImport, setEdlImport] = useState<{ source: string; destination: string } | null>(null);
  const [timelinePreview, setTimelinePreview] = useState<TimelineImportPreview | null>(null);

  const begin = useCallback(async () => {
    if (busy || edlImport !== null || timelinePreview !== null) return;
    setBusy(true);
    setError(null);
    onError?.(null);
    try {
      const source = await openDialog({
        title: t("startup.import_timeline_title"),
        filters: [{ name: "Timeline interchange", extensions: ["fcpxml", "edl"] }],
      });
      if (typeof source !== "string") return;
      const name = source.split(/[\/]/).pop()!.replace(/\.(fcpxml|edl)$/i, "");
      const destination = await saveDialog({
        title: t("startup.import_timeline_destination"),
        defaultPath: t("startup.import_timeline_folder", { name }),
      });
      if (!destination) return;
      if (/\.edl$/i.test(source)) setEdlImport({ source, destination });
      else setTimelinePreview(await projectPreviewTimeline(source, destination));
    } catch (cause) {
      const message = t("startup.import_timeline_failed", { detail: cleanIpcDetail(cause) });
      if (onError) onError(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, edlImport, timelinePreview, t, onError]);

  const dialogs = (
    <>
      {error && (
        <AppDialog title={t("startup.import_timeline_title")} onClose={() => setError(null)} panelClassName="new-project-panel">
          <p className="new-project-error" role="alert">{error}</p>
          <footer className="new-project-actions">
            <Button onClick={() => setError(null)}>{t("new_project.cancel")}</Button>
          </footer>
        </AppDialog>
      )}
      {edlImport && (
        <EdlImportForm
          onCancel={() => setEdlImport(null)}
          onImport={async (options) => {
            const preview = await projectPreviewTimeline(edlImport.source, edlImport.destination, options);
            setEdlImport(null);
            setTimelinePreview(preview);
          }}
        />
      )}
      {timelinePreview && (
        <TimelineImportReview
          preview={timelinePreview}
          onCancel={() => {
            void projectDiscardTimelinePreview(timelinePreview.id).catch(() => {});
            setTimelinePreview(null);
          }}
          onImport={async () => {
            await projectImportTimeline(timelinePreview.id);
            setTimelinePreview(null);
            onImported();
          }}
        />
      )}
    </>
  );
  return { begin, busy, dialogs };
}

function TimelineImportReview({ preview, onImport, onCancel }: {
  preview: TimelineImportPreview;
  onImport: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    try { await onImport(); }
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
      {preview.roundedEnds > 0 && <p>{t("startup.timeline_review_rounding")}</p>}
      {preview.resampledAudioClips > 0 && <p role="status">{t("startup.timeline_review_audio_resample", { count: preview.resampledAudioClips })}</p>}
      {preview.downmixedAudioClips > 0 && <p role="status">{t("startup.timeline_review_audio_downmix", { count: preview.downmixedAudioClips })}</p>}
      {error && <p className="new-project-error" role="alert">{error}</p>}
      <footer className="new-project-actions">
        <Button size="lg" onClick={onCancel} disabled={busy}>{t("new_project.cancel")}</Button>
        <Button size="lg" onClick={submit} disabled={busy || error !== null}>
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
