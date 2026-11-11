import { open, mkdir, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import { validateProjectName } from '../../../shared/newProject'
import { compareTime, exactTime, floorTime, multiplyTime, roundTime } from '../../../renderer/timeMapping'
import { splitExact, writeSourceWindow } from '../../../renderer/layerTiming'
import { createActor } from '../actor'
import { type IdGen } from '../ids'
import { createMediaImporter, type MediaImportDeps } from '../mediaImport'
import { blankProject, rootComposition, type AudioParams, type Layer, type MediaItem, type Project } from '../model'
import { DEFAULT_MARKER_COLOR } from '../mutations/add'
import { audioParams, videoClipParams } from '../mutations/media'
import { applyDurationAutofit } from '../mutations/helpers'
import { PROJECT_FILE, serializeProjectToJson } from '../persistence'
import { AUDIO_GRID, timeUsAtFrame, timeUsAtGridIndex } from '../snap'
import { validate } from '../validate'
import type { OrchestratorDeps } from '../workspace-orchestrator'
import { parseFcpxml, type FcpxmlTimeline } from './fcpxml'

type MediaDeps = Pick<MediaImportDeps, 'compute' | 'statPath' | 'realPath' | 'fileKey'>
type Clip = FcpxmlTimeline['clips'][number]
const MAX_XML_BYTES = 16 * 1024 * 1024

export function timelineDestination(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Choose an absolute path for a new project folder')
  const path = resolve(value)
  const name = basename(path)
  if (path === dirname(path) || /[\x00-\x1f\x7f]/.test(name) || validateProjectName(name)) {
    throw new Error('Choose a valid name for the new project folder')
  }
  return path
}

async function readFcpxml(path: unknown, deps: MediaDeps): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || extname(path).toLowerCase() !== '.fcpxml')
    throw new Error('Choose a local .fcpxml file')
  const facts = deps.statPath(path)
  if (facts?.kind !== 'file' || !facts.readable) throw new Error('The selected FCPXML file is missing or unreadable')
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_XML_BYTES) throw new Error('Choose a regular FCPXML file up to 16 MiB')
    const data = Buffer.alloc(stat.size + 1)
    let read = 0
    while (read < data.length) {
      const result = await file.read(data, read, data.length - read, read)
      if (result.bytesRead === 0) break
      read += result.bytesRead
    }
    if (read !== stat.size) throw new Error('The FCPXML file changed during import. Try again after the file is ready')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, read)) }
    catch { throw new Error('Export the FCPXML document as UTF-8 and try again') }
  } finally { await file.close() }
}

export async function prepareFcpxmlProject(
  path: unknown, destination: string, idGen: IdGen, deps: MediaDeps, assertCurrent: () => void,
): Promise<Project> {
  const timeline = parseFcpxml(await readFcpxml(path, deps))
  assertCurrent()
  const initial = blankProject(idGen, timeline.name?.trim() || basename(destination))
  Object.assign(rootComposition(initial), { width: timeline.width, height: timeline.height, fps: timeline.fps })
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
  const target = { ...root, tracks: root.tracks.map((track) => ({ ...track, layers: [] as Layer[] })),
    links: [...root.links], markers: [...root.markers] }
  const track = target.tracks[0]!
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
  for (const clip of timeline.clips) {
    const item = snapshot.media_pool[mediaIds.get(clip.asset.path)!]!
    validateSource(timeline, clip, item)
    const t0 = boundary(clip.firstFrame), t1 = boundary(clip.endFrame)
    const video = newLayer(idGen, clip, t0, t1, videoClipParams(item.id, 0, 0, target))
    track.layers.push(video)
    if (clip.asset.hasAudio) {
      const a0 = sampleBoundary(clip.firstFrame), a1 = sampleBoundary(clip.endFrame)
      const audio = newLayer(idGen, clip, a0, a1, { ...audioParams(item.id, 0, 0), role: clip.audioRole })
      track.layers.push(audio)
      target.links.push({ id: idGen(), members: [video.id, audio.id].sort() })
    }
    for (const mark of clip.markers) {
      const { whole, fraction } = splitExact(mark.source)
      target.markers.push({
        id: idGen(), t_us: boundary(mark.frame), end_t_us: null, label: mark.label, note: '',
        color: DEFAULT_MARKER_COLOR, anchor: { layer: video.id, src_us: whole, ...(fraction.num ? { src_fraction: fraction } : {}) },
      })
    }
  }
  track.layers.sort((a, b) => a.t_start_us - b.t_start_us)
  target.markers.sort((a, b) => a.t_us - b.t_us)
  applyDurationAutofit(target)
  if (sequenceEnd > target.duration_us) {
    target.duration_us = sequenceEnd
    target.duration_pinned = true
  }
  const project = { ...snapshot, compositions: { ...snapshot.compositions, [root.id]: target } }
  validate(project)
  return project
}

function newLayer(idGen: IdGen, clip: Clip, start: number, end: number, params: Extract<Layer['params'], { kind: 'VideoClip' }> | AudioParams): Layer {
  writeSourceWindow(params, clip.sourceIn, clip.sourceOut)
  return { id: idGen(), label: clip.label ?? null, t_start_us: start, t_end_us: end,
    enabled: true, locked: false, metadata: {}, params, effects: [] }
}

function validateSource(timeline: FcpxmlTimeline, clip: Clip, item: MediaItem): void {
  const { video, audio, duration_us: duration } = item.metadata
  const fail = (message: string): never => { throw new Error(`FCPXML ${clip.location}, asset ${clip.asset.ref}: ${message}`) }
  if (item.kind !== 'Video' || !video || video.width !== timeline.width || video.height !== timeline.height ||
      !video.fps_num || !video.fps_den || video.fps_num * timeline.fps.den !== video.fps_den * timeline.fps.num) {
    fail('The original must be a video with the sequence size and frame rate. Relink or render conforming media')
  }
  if (Boolean(audio) !== clip.asset.hasAudio || (audio && (
    !audio.channels || ![1, 2].includes(audio.channels) || !audio.sample_rate ||
    (clip.asset.audioChannels !== undefined && clip.asset.audioChannels !== audio.channels) ||
    (clip.asset.audioRate !== undefined && clip.asset.audioRate !== audio.sample_rate)))) {
    fail('Embedded audio differs from the asset declaration. Relink the matching original and export again')
  }
  if (duration == null || compareTime(clip.sourceOut, exactTime(duration)) > 0)
    fail('The trim exceeds the probed duration of the original file. Relink the matching original or shorten the trim')
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
