import { open as openDialog } from "@/bridge/dialog";
import { useState } from "react";
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
import type { TimelineEditBlocked, TimelineImportPreview, TimelineMediaBlocked, TimelineMediaChange, TimelineMediaReplacement, TimelineSequenceChoice } from "../../shared/timelineImport";
import { fpsLabel } from "./canvasPresets";
import { cleanIpcDetail } from "./openError";
import { NewProjectForm } from "./NewProjectForm";

export function useTimelineImportFlow({ fromStartup, onWorkspaceReady }: { fromStartup: boolean; onWorkspaceReady: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [sourcePicker, setSourcePicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectForm, setProjectForm] = useState<TimelineImportPreview | null>(null);
  const [timelinePreview, setTimelinePreview] = useState<TimelineImportPreview | null>(null);
  const [blocked, setBlocked] = useState<TimelineMediaBlocked | TimelineEditBlocked | null>(null);
  const [request, setRequest] = useState<ReviewRequest | null>(null);
  const [sequenceImport, setSequenceImport] = useState<{ source: string; documentId: string; choices: TimelineSequenceChoice[]; newProject: boolean } | null>(null);

  const begin = () => {
    if (!busy && !error && !blocked && !sequenceImport && !timelinePreview && !projectForm) setSourcePicker(true);
  };

  function reportError(cause: unknown) {
    setError(t("startup.import_timeline_failed", { detail: cleanIpcDetail(cause) }));
  }

  async function review(next: ReviewRequest) {
    setRequest(next);
    const result = await projectPreviewTimeline(next.source, next.folder, next.index, next.newProject, next.replacements, next.documentId, next.omitEffects, next.leaveTitleGaps);
    if ("kind" in result) setBlocked(result);
    else setTimelinePreview(result);
  }

  async function chooseSource(bundle: boolean) {
    if (busy) return;
    setSourcePicker(false);
    setBusy(true);
    try {
      const source = await openDialog({
        title: t("startup.import_timeline_title"),
        ...(bundle ? { directory: true, treatPackageAsDirectory: true } : { filters: [{ name: "FCPXML", extensions: ["fcpxml"] }] }),
      });
      if (typeof source !== "string") return;
      const { choices, documentId } = await projectListTimelineSequences(source);
      if (choices.length > 1) setSequenceImport({ source, choices, documentId, newProject: fromStartup });
      else await review({ source, documentId, index: 0, newProject: fromStartup, replacements: [] });
    } catch (cause) { reportError(cause); }
    finally { setBusy(false); }
  }

  async function chooseSequence(index: number) {
    if (!sequenceImport || busy) return;
    const { source, documentId, newProject } = sequenceImport;
    setSequenceImport(null);
    setBusy(true);
    try { await review({ source, documentId, index, newProject, replacements: [] }); }
    catch (cause) { reportError(cause); }
    finally { setBusy(false); }
  }

  async function relink(assetRef?: string, suggestedPath?: string) {
    if (!request || busy) return;
    setBusy(true);
    try {
      const path = suggestedPath ?? await openDialog({
        title: t(assetRef ? "startup.import_choose_replacement" : "startup.import_choose_relink_folder"),
        directory: assetRef === undefined,
      });
      if (typeof path !== "string") return;
      const next = assetRef === undefined
        ? { ...request, folder: path }
        : { ...request, replacements: [...request.replacements.filter(choice => choice.assetRef !== assetRef), { assetRef, path }] };
      setBlocked(null);
      setTimelinePreview(null);
      await review(next);
    } catch (cause) { reportError(cause); }
    finally { setBusy(false); }
  }

  async function reviewWithFallback(option: "omitEffects" | "leaveTitleGaps") {
    if (!request || busy) return;
    setBusy(true);
    setBlocked(null);
    try { await review({ ...request, [option]: true }); }
    catch (cause) { reportError(cause); }
    finally { setBusy(false); }
  }

  async function reviewAsNewProject() {
    if (!request || busy) return;
    setBusy(true);
    setTimelinePreview(null);
    try { await review({ ...request, newProject: true }); }
    catch (cause) { reportError(cause); }
    finally { setBusy(false); }
  }

  async function refreshReview() {
    if (!request || busy) return;
    setBusy(true);
    setTimelinePreview(null);
    setProjectForm(null);
    try {
      const { choices, documentId } = await projectListTimelineSequences(request.source);
      if (documentId === request.documentId) await review(request);
      else if (choices.length > 1) setSequenceImport({ source: request.source, choices, documentId, newProject: request.newProject });
      else await review({ source: request.source, documentId, index: 0, newProject: request.newProject, replacements: [] });
    } catch (cause) { reportError(cause); }
    finally { setBusy(false); }
  }

  function cancel() {
    const preview = timelinePreview ?? projectForm;
    if (preview) void projectDiscardTimelinePreview(preview.id).catch(() => {});
    setProjectForm(null);
    setTimelinePreview(null);
    setBlocked(null);
    setRequest(null);
    setError(null);
  }

  const editIssues = blocked?.kind === "media-blocked" ? blocked.editIssues : blocked?.issues ?? [];
  const canLeaveTitleGaps = editIssues.some(issue => issue.recovery === "leave-title-gap") &&
    editIssues.every(issue => issue.recovery !== undefined);
  const titleFallback = canLeaveTitleGaps && (
    <Button onClick={() => void reviewWithFallback("leaveTitleGaps")} disabled={busy}>
      {t("startup.import_review_without_titles")}
    </Button>
  );

  const dialogs = (
    <>
      {sourcePicker && (
        <AppDialog title={t("startup.import_timeline_title")} onClose={() => setSourcePicker(false)} panelClassName="new-project-panel">
          <Button onClick={() => void chooseSource(false)}>{t("startup.import_fcpxml_file")}</Button>
          <Button onClick={() => void chooseSource(true)}>{t("startup.import_fcpxml_bundle")}</Button>
        </AppDialog>
      )}
      {error && (
        <AppDialog title={t("startup.import_timeline_title")} onClose={cancel} panelClassName="new-project-panel">
          <p className="new-project-error whitespace-pre-wrap break-words" role="alert">{error}</p>
          <footer className="new-project-actions">
            <Button onClick={cancel}>{t("new_project.cancel")}</Button>
          </footer>
        </AppDialog>
      )}
      {blocked?.kind === "edit-blocked" && (
        <AppDialog title={t("startup.import_edit_blocked")} onClose={busy ? undefined : cancel} panelClassName="new-project-panel">
          {blocked.issues.map((issue, index) => (
            <div key={index} className="new-project-row">
              <strong>{issue.label}</strong>
              {issue.timelineFrames && <p>{t("startup.import_edit_range", issue.timelineFrames)}</p>}
              <p role="alert">{issue.notes.join(" ")}</p>
            </div>
          ))}
          {blocked.mediaChanges.length > 0 && (
            <section aria-label={t("startup.import_media_differences")}>
              <p><strong>{t("startup.import_media_differences")}</strong></p>
              <MediaDifferenceRows changes={blocked.mediaChanges} onRelink={relink} disabled={busy} />
            </section>
          )}
          <footer className="new-project-actions">
            <Button onClick={cancel} disabled={busy}>{t("new_project.cancel")}</Button>
            {blocked.canOmitEffects && <Button onClick={() => void reviewWithFallback("omitEffects")} disabled={busy}>
              {t("startup.import_review_without_effects")}
            </Button>}
            {titleFallback}
          </footer>
        </AppDialog>
      )}
      {blocked?.kind === "media-blocked" && (
        <AppDialog title={t("startup.import_media_blocked")} onClose={busy ? undefined : cancel} panelClassName="new-project-panel">
          {blocked.issues.map((issue, index) => (
            <div key={index} className="new-project-row">
              <strong title={issue.sourcePath}>{issue.label}</strong>
              {issue.label !== issue.filename && <p>{issue.filename}</p>}
              <p className="new-project-error break-words" role="alert">{issue.detail}</p>
              {issue.suggestedPaths?.map(path => (
                <Button key={path} title={path} onClick={() => void relink(issue.assetRef, path)} disabled={busy}>
                  {t("startup.import_use_candidate", { name: path.split(/[\\/]/).pop() })}
                </Button>
              ))}
              <Button onClick={() => void relink(issue.assetRef)} disabled={busy}>
                {t("startup.import_choose_replacement")}
              </Button>
            </div>
          ))}
          {blocked.editIssues.map((issue, index) => (
            <div key={index} className="new-project-row">
              <strong>{issue.label}</strong>
              {issue.timelineFrames && <p>{t("startup.import_edit_range", issue.timelineFrames)}</p>}
              <p>{issue.notes.join(" ")}</p>
            </div>
          ))}
          {blocked.mediaChanges.length > 0 && (
            <section aria-label={t("startup.import_media_differences")}>
              <p><strong>{t("startup.import_media_differences")}</strong></p>
              <MediaDifferenceRows changes={blocked.mediaChanges} onRelink={relink} disabled={busy} />
            </section>
          )}
          <footer className="new-project-actions">
            <Button onClick={cancel} disabled={busy}>{t("new_project.cancel")}</Button>
            {blocked.editIssues.some(issue => issue.recovery === "omit-effect") && <Button onClick={() => void reviewWithFallback("omitEffects")} disabled={busy}>
              {t("startup.import_review_without_effects")}
            </Button>}
            {titleFallback}
            {blocked.canSearchFolder && <Button onClick={() => void relink()} disabled={busy}>
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
      {projectForm && (
        <NewProjectForm timeline={projectForm} onCancel={cancel} onReviewTimeline={refreshReview} onCreated={() => {
          setProjectForm(null);
          setRequest(null);
          onWorkspaceReady();
        }} />
      )}
      {timelinePreview && (
        <TimelineImportReview
          preview={timelinePreview}
          busyRelinking={busy}
          onRelink={relink}
          onReviewAsNewProject={reviewAsNewProject}
          onRefreshReview={refreshReview}
          onCancel={cancel}
          onImport={async (canvas, acceptMediaChanges, acceptOmittedEffects, acceptTitleGaps) => {
            if (timelinePreview.current === null) setProjectForm(timelinePreview);
            else await projectImportTimeline(timelinePreview.id, canvas, undefined, acceptMediaChanges, acceptOmittedEffects, acceptTitleGaps);
            setTimelinePreview(null);
          }}
        />
      )}
    </>
  );
  return { begin, busy, dialogs };
}

interface ReviewRequest {
  source: string;
  documentId: string;
  index: number;
  newProject: boolean;
  folder?: string;
  replacements: TimelineMediaReplacement[];
  omitEffects?: boolean;
  leaveTitleGaps?: boolean;
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

function MediaDifferenceRows({ changes, onRelink, disabled }: {
  changes: TimelineMediaChange[];
  onRelink: (assetRef: string) => Promise<void>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return changes.map((issue, index) => (
    <div key={index} className="new-project-row">
      <strong title={issue.sourcePath}>{issue.label}</strong>
      {issue.label !== issue.filename && <p>{issue.filename}</p>}
      <p>{issue.detail} {t("startup.import_media_placements", { count: issue.placements })}</p>
      <Button disabled={disabled} onClick={() => void onRelink(issue.assetRef)}>
        {t("startup.import_choose_replacement")}
      </Button>
    </div>
  ));
}

function TimelineImportReview({ preview, onImport, onCancel, onRelink, onReviewAsNewProject, onRefreshReview, busyRelinking }: {
  preview: TimelineImportPreview;
  onImport: (canvas: 'fit' | 'fill' | 'original', acceptMediaChanges: boolean, acceptOmittedEffects: boolean, acceptTitleGaps: boolean) => Promise<void>;
  onRelink: (assetRef: string) => Promise<void>;
  onReviewAsNewProject: () => Promise<void>;
  onRefreshReview: () => Promise<void>;
  busyRelinking: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<'fit' | 'fill' | 'original'>('fit');
  const [acceptMediaChanges, setAcceptMediaChanges] = useState(false);
  const [acceptOmittedEffects, setAcceptOmittedEffects] = useState(false);
  const [acceptTitleGaps, setAcceptTitleGaps] = useState(false);
  const hasMediaChanges = preview.mediaChanges.length > 0 || preview.outputColorChange !== null;
  const current = preview.current;
  const fpsMismatch = current != null &&
    current.fps.num * preview.fps.den !== preview.fps.num * current.fps.den;
  const sizeMismatch = current != null &&
    (current.width !== preview.width || current.height !== preview.height);

  async function submit() {
    setBusy(true);
    try { await onImport(canvas, acceptMediaChanges, acceptOmittedEffects, acceptTitleGaps); }
    catch (cause) {
      setError(cleanIpcDetail(cause));
      setBusy(false);
    }
  }

  return (
    <AppDialog title={t("startup.timeline_review")} onClose={busy || busyRelinking ? undefined : onCancel} panelClassName="new-project-panel">
      <p>{preview.name}</p>
      {preview.destination && <p className="new-project-preview" title={preview.destination}>{preview.destination}</p>}
      <p>{t("startup.timeline_review_format", {
        width: preview.width, height: preview.height, rate: fpsLabel(preview.fps, t), frames: preview.durationFrames,
      })}</p>
      <p>{t("startup.timeline_review_contents", {
        video: preview.videoClips, audio: preview.audioClips, markers: preview.markers, media: preview.media,
      })}</p>
      {preview.compoundGroups > 0 && <p>{t("startup.timeline_review_compound_groups", { count: preview.compoundGroups })}</p>}
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
          {!fpsMismatch && <p>{t("startup.import_existing_group_hint")}</p>}
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
          {sizeMismatch && !fpsMismatch && (
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
      {hasMediaChanges && (
        <section aria-label={t("startup.import_media_differences")}>
          <p><strong>{t("startup.import_media_differences")}</strong></p>
          {preview.outputColorChange && <p>{t("startup.import_output_color_difference", { color: preview.outputColorChange })}</p>}
          <MediaDifferenceRows changes={preview.mediaChanges} onRelink={onRelink} disabled={busy || busyRelinking} />
          <label>
            <input type="checkbox" checked={acceptMediaChanges} disabled={busy || busyRelinking}
              onChange={(event) => setAcceptMediaChanges(event.target.checked)} />
            {" "}{t("startup.import_accept_media_differences")}
          </label>
        </section>
      )}
      {preview.omittedEffects.length > 0 && (
        <section aria-label={t("startup.import_effects_omitted")}>
          <p><strong>{t("startup.import_effects_omitted")}</strong></p>
          {preview.omittedEffects.map((effect, index) => <p key={index}>{effect.label} · {effect.location}</p>)}
          <label>
            <input type="checkbox" checked={acceptOmittedEffects} disabled={busy || busyRelinking}
              onChange={(event) => setAcceptOmittedEffects(event.target.checked)} />
            {" "}{t("startup.import_accept_omitted_effects")}
          </label>
        </section>
      )}
      {preview.omittedTitles.length > 0 && (
        <section aria-label={t("startup.import_titles_omitted")}>
          <p><strong>{t("startup.import_titles_omitted")}</strong></p>
          {preview.omittedTitles.map((title, index) => (
            <div key={index}>
              <strong>{title.label}</strong>
              {title.timelineFrames && <p>{t("startup.import_edit_range", title.timelineFrames)}</p>}
            </div>
          ))}
          <label>
            <input type="checkbox" checked={acceptTitleGaps} disabled={busy || busyRelinking}
              onChange={(event) => setAcceptTitleGaps(event.target.checked)} />
            {" "}{t("startup.import_accept_title_gaps")}
          </label>
        </section>
      )}
      {preview.relinkedMedia.length > 0 && (
        <section aria-label={t("startup.import_relinked_media")}>
          <p><strong>{t("startup.import_relinked_media")}</strong></p>
          {preview.relinkedMedia.map(({ assetRef, label, from, to }) => (
            <div key={assetRef} className="new-project-row">
              <strong>{label}</strong>
              <p className="new-project-preview" title={from + " → " + to}>{from} → {to}</p>
              <Button onClick={() => void onRelink(assetRef)} disabled={busy || busyRelinking}>
                {t("startup.import_choose_replacement")}
              </Button>
            </div>
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
        <Button size="lg" onClick={onCancel} disabled={busy || busyRelinking}>{t("new_project.cancel")}</Button>
        {error && (
          <Button size="lg" onClick={() => void onRefreshReview()} disabled={busy || busyRelinking}>
            {t("startup.import_refresh_review")}
          </Button>
        )}
        {fpsMismatch && (
          <Button size="lg" onClick={() => void onReviewAsNewProject()} disabled={busy || busyRelinking}>
            {t("startup.import_review_as_new")}
          </Button>
        )}
        <Button size="lg" onClick={submit} disabled={busy || busyRelinking || error !== null || fpsMismatch || (hasMediaChanges && !acceptMediaChanges) || (preview.omittedEffects.length > 0 && !acceptOmittedEffects) || (preview.omittedTitles.length > 0 && !acceptTitleGaps)}>
          {t(busy ? "startup.import_timeline_busy" : current ? "startup.import_timeline_submit" : "startup.import_timeline_location")}
        </Button>
      </footer>
    </AppDialog>
  );
}
