import { open, mkdir, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import { canvasSizeError, validateProjectName } from '../../../shared/newProject'
import type { ExactTime } from '../../../shared/timeMapping'
import { compareTime, exactTime, floorTime, multiplyTime, roundTime } from '../../../renderer/timeMapping'
import { splitExact, writeSourceWindow } from '../../../renderer/layerTiming'
import { createActor } from '../actor'
import { type IdGen } from '../ids'
import { createMediaImporter, type MediaImportDeps } from '../mediaImport'
import { blankProject, rootComposition, type AudioParams, type Layer, type MediaItem, type Project } from '../model'
import { applyAddTrack, DEFAULT_MARKER_COLOR } from '../mutations/add'
import { audioParams, imageOverlayParams, videoClipParams } from '../mutations/media'
import { applyDurationAutofit } from '../mutations/helpers'
import { PROJECT_FILE, serializeProjectToJson } from '../persistence'
import { AUDIO_GRID, timeUsAtFrame, timeUsAtGridIndex } from '../snap'
import { validate } from '../validate'
import type { OrchestratorDeps } from '../workspace-orchestrator'
import { parseEdl } from './edl'
import { parseFcpxml } from './fcpxml'
import type { TimelineClip } from './timeline'
import type { TimelineImportReport } from '../../../shared/timelineImport'

type MediaDeps = Pick<MediaImportDeps, 'compute' | 'statPath' | 'realPath' | 'fileKey'>
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

export function timelineDestination(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Choose an absolute path for a new project folder')
  const path = resolve(value)
  const name = basename(path)
  if (path === dirname(path) || /[\x00-\x1f\x7f]/.test(name) || validateProjectName(name)) {
    throw new Error('Choose a valid name for the new project folder')
  }
  return path
}

async function readTimelineDocument(path: string, deps: MediaDeps): Promise<string> {
  const facts = deps.statPath(path)
  if (facts?.kind !== 'file' || !facts.readable) throw new Error('The selected timeline file is missing or unreadable')
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new Error('Choose a regular timeline file up to 16 MiB')
    const data = Buffer.alloc(stat.size + 1)
    let read = 0
    while (read < data.length) {
      const result = await file.read(data, read, data.length - read, read)
      if (result.bytesRead === 0) break
      read += result.bytesRead
    }
    if (read !== stat.size) throw new Error('The timeline file changed during import. Try again after the file is ready')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, read)) }
    catch { throw new Error('Export the timeline document as UTF-8 and try again') }
  } finally { await file.close() }
}

export async function prepareTimelineProject(
  path: unknown, destination: string, edlOptions: unknown, idGen: IdGen, deps: MediaDeps, assertCurrent: () => void,
): Promise<{ project: Project; report: TimelineImportReport }> {
  const extension = typeof path === 'string' && isAbsolute(path) ? extname(path).toLowerCase() : ''
  if (typeof path !== 'string' || (extension !== '.fcpxml' && extension !== '.edl')) {
    throw new Error('Choose a local .fcpxml or .edl file')
  }
  const document = await readTimelineDocument(path, deps)
  const timeline = extension === '.edl' ? parseEdl(document, edlOptions) : parseFcpxml(document)
  assertCurrent()
  const initial = blankProject(idGen, timeline.name?.trim() || basename(destination))
  rootComposition(initial).fps = timeline.fps
  const actor = createActor({ initial, idGen, clock: () => new Date().toISOString() })
  // The standard importer deduplicates and hashes in a private actor. Opening
  // the finished project starts the usual workspace copies and derivatives.
  const importer = createMediaImporter({
    ...deps, actor, workspaceDir: () => null,
    enqueueDerivatives: async () => {}, enqueueWorkspaceCopy: async () => {},
  })
  const paths = new Map(timeline.clips.map((clip) => [clip.asset.path, clip.asset.ref]))
  const missing: string[] = []
  for (const [mediaPath, ref] of paths) {
    try { importer.checkPath(mediaPath) }
    catch { missing.push(`${ref} (${mediaPath})`) }
  }
  if (missing.length) {
    const extra = missing.length > 5 ? ` and ${missing.length - 5} more` : ''
    throw new Error(`Missing or unreadable original media: ${missing.slice(0, 5).join(', ')}${extra}. Relink in the source editor and export again`)
  }

  const mediaIds = new Map<string, string>()
  for (const [mediaPath, ref] of paths) {
    assertCurrent()
    try { mediaIds.set(mediaPath, (await importer.ensureImported(mediaPath)).mediaId) }
    catch (error) {
      throw new Error(`Could not import asset ${ref} (${mediaPath}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  assertCurrent()
  const snapshot = actor.snapshot()
  const root = rootComposition(snapshot)
  const itemOf = (clip: TimelineClip) => snapshot.media_pool[mediaIds.get(clip.asset.path)!]!
  const video = timeline.canvas ? null : itemOf(timeline.clips[0]!).metadata.video
  const width = timeline.canvas?.width ?? video?.width ?? 0
  const height = timeline.canvas?.height ?? video?.height ?? 0
  if (canvasSizeError(width, height)) throw new Error('The original media must have a supported even-sized WeftCut canvas')
  const target = { ...root, width, height, tracks: root.tracks.map((track) => ({ ...track, layers: [] as Layer[] })),
    links: [...root.links], markers: [...root.markers] }
  const project = { ...snapshot, compositions: { ...snapshot.compositions, [root.id]: target } }
  const laneIds = new Map([[0, target.tracks[0]!.id]])
  const lanes = [...new Set(timeline.clips.map((clip) => clip.lane))].sort((a, b) => a - b)
  let lowerTracks = 0
  let firstOverlay = true
  for (const lane of lanes) {
    if (lane < 0) laneIds.set(lane, applyAddTrack(project, idGen, null, lowerTracks++))
    if (lane > 0) {
      laneIds.set(lane, firstOverlay ? target.tracks[lowerTracks + 1]!.id : applyAddTrack(project, idGen, null))
      firstOverlay = false
    }
  }
  const tracks = new Map(target.tracks.map((track) => [track.id, track]))
  const boundary = (frame: number) => timeUsAtFrame(frame, target.fps.num, target.fps.den)
  const frameDuration = exactTime(1_000_000 * target.fps.den, target.fps.num)
  const samplesPerFrame = multiplyTime(frameDuration, exactTime(AUDIO_GRID.num, 1_000_000))
  const sequenceEnd = boundary(timeline.durationFrames)
  const sampleBoundary = (frame: number) => {
    const sample = multiplyTime(exactTime(frame), samplesPerFrame)
    const nearest = timeUsAtGridIndex(roundTime(sample), AUDIO_GRID)
    // A terminal sample boundary past the last frame would extend the project
    // by a whole frame when WeftCut fits its duration to the last clip.
    return nearest <= sequenceEnd ? nearest : timeUsAtGridIndex(floorTime(sample), AUDIO_GRID)
  }
  let videoClips = 0
  let audioClips = 0
  let roundedEnds = 0
  for (const clip of timeline.clips) {
    const item = itemOf(clip)
    const sourceOut = validateSource(target, clip, item)
    if (sourceOut !== clip.sourceOut) roundedEnds++
    const track = tracks.get(laneIds.get(clip.lane)!)!
    const video = clip.asset.hasVideo && !clip.asset.stillImage
      ? newLayer(idGen, clip, sourceOut, boundary(clip.firstFrame), boundary(clip.endFrame), videoClipParams(item.id, 0, 0, target))
      : null
    const image = clip.asset.stillImage
      ? newLayer(idGen, clip, sourceOut, boundary(clip.firstFrame), boundary(clip.endFrame),
        imageOverlayParams(item.id, { width, height }) as Extract<Layer['params'], { kind: 'ImageOverlay' }>)
      : null
    const audio = clip.audioRole
      ? newLayer(idGen, clip, sourceOut, sampleBoundary(clip.firstFrame), sampleBoundary(clip.endFrame), { ...audioParams(item.id, 0, 0), role: clip.audioRole })
      : null
    if (video || image) { track.layers.push((video ?? image)!); videoClips++ }
    if (audio) { track.layers.push(audio); audioClips++ }
    if (video && audio) target.links.push({ id: idGen(), members: [video.id, audio.id].sort() })
    for (const mark of clip.markers) {
      const { whole, fraction } = splitExact(mark.source)
      target.markers.push({
        id: idGen(), t_us: boundary(mark.frame), end_t_us: null, label: mark.label, note: '',
        color: DEFAULT_MARKER_COLOR, anchor: { layer: (video ?? image ?? audio)!.id, src_us: whole, ...(fraction.num ? { src_fraction: fraction } : {}) },
      })
    }
  }
  for (const track of target.tracks) track.layers.sort((a, b) => a.t_start_us - b.t_start_us)
  target.markers.sort((a, b) => a.t_us - b.t_us)
  applyDurationAutofit(target)
  if (sequenceEnd > target.duration_us) {
    target.duration_us = sequenceEnd
    target.duration_pinned = true
  }
  validate(project)
  return { project, report: {
    name: project.metadata.name, destination, width, height, fps: target.fps, durationFrames: timeline.durationFrames,
    videoClips, audioClips, markers: target.markers.length, media: Object.keys(snapshot.media_pool).length,
    lanes, connectedClips: timeline.clips.filter((clip) => clip.lane !== 0).length, roundedEnds,
  } }
}

function newLayer(idGen: IdGen, clip: TimelineClip, sourceOut: ExactTime, start: number, end: number, params: Extract<Layer['params'], { kind: 'VideoClip' | 'ImageOverlay' }> | AudioParams): Layer {
  // A still image has no moving source clock. Its authored span is on the
  // composition timeline, not a range within a zero-duration image asset.
  if (params.kind !== 'ImageOverlay') writeSourceWindow(params, clip.sourceIn, sourceOut)
  return { id: idGen(), label: clip.label ?? null, t_start_us: start, t_end_us: end,
    enabled: true, locked: false, metadata: {}, params, effects: [] }
}

function validateSource(timeline: Pick<ReturnType<typeof rootComposition>, 'width' | 'height' | 'fps'>, clip: TimelineClip, item: MediaItem): ExactTime {
  const { video, audio, duration_us: duration } = item.metadata
  const fail = (message: string): never => { throw new Error(`${clip.location}, source ${clip.asset.ref}: ${message}`) }
  if (clip.asset.stillImage) {
    // The normal image probe may report width/height in metadata.video even
    // though the media is an Image, not a moving VideoClip. Image kind is the
    // authoritative distinction; a real audio stream remains unsupported.
    if (item.kind !== 'Image' || audio) {
      fail('A zero-duration FCPXML still image must reference original image media without audio')
    }
    return clip.sourceOut
  }
  if (clip.asset.hasVideo) {
    if (item.kind !== 'Video' || !video || video.width !== timeline.width || video.height !== timeline.height ||
        !video.fps_num || !video.fps_den || video.fps_num * timeline.fps.den !== video.fps_den * timeline.fps.num) {
      fail('The original must be a video with the sequence size and frame rate. Relink or render conforming media')
    }
  } else if (item.kind !== 'Audio' || video) {
    fail('The original must be an audio-only file. Relink the matching original and export again')
  }
  if ((clip.asset.hasAudio !== undefined && Boolean(audio) !== clip.asset.hasAudio) || (clip.audioRole && audio && (
    !audio.channels || ![1, 2].includes(audio.channels) || !audio.sample_rate ||
    (clip.asset.audioChannels !== undefined && clip.asset.audioChannels !== audio.channels) ||
    (clip.asset.audioRate !== undefined && clip.asset.audioRate !== audio.sample_rate)))) {
    fail('Embedded audio differs from the asset declaration. Relink the matching original and export again')
  }
  if (duration != null) {
    const end = exactTime(duration)
    if (compareTime(clip.sourceOut, end) <= 0) return clip.sourceOut
    // ffprobe reports duration to whole microseconds. At fractional rates the
    // final exclusive frame boundary can round down to this same endpoint.
    if (roundTime(clip.sourceOut) === duration && compareTime(clip.sourceIn, end) < 0) return end
  }
  return fail('The trim exceeds the probed duration of the original file. Relink the matching original or shorten the trim')
}

type PublicationDeps = Pick<OrchestratorDeps, 'actor' | 'join' | 'enqueueDerivatives'> & {
  napi: Pick<OrchestratorDeps['napi'], 'commitWorkspace' | 'pushRecent'>
}

export async function publishTimelineProject(deps: PublicationDeps, dir: string, project: Project): Promise<void> {
  validate(project)
  const file = deps.join(dir, PROJECT_FILE)
  const text = serializeProjectToJson(project)
  try { await mkdir(dir) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('That project folder already exists. Choose a new name or location')
    throw error
  }
  let ownsFile = false
  try {
    const handle = await open(file, 'wx')
    ownsFile = true
    try { await handle.writeFile(text, 'utf8'); await handle.sync() }
    finally { await handle.close() }
    await deps.napi.commitWorkspace(dir)
  } catch (error) {
    if (ownsFile) await unlink(file).catch(() => {})
    await rmdir(dir).catch(() => {})
    throw error
  }
  deps.actor.replaceState(project)
  try { await deps.napi.pushRecent(dir, project.metadata.name) }
  catch (error) { console.warn('[timeline import] Could not update recent projects', error) }
  deps.enqueueDerivatives?.(project)
}
