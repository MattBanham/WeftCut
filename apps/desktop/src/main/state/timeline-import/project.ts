import { lstat, open, mkdir, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { canvasSizeError, validateProjectName } from '../../../shared/newProject'
import type { ExactTime } from '../../../shared/timeMapping'
import { compareTime, divideTime, exactTime, floorTime, multiplyTime, roundTime } from '../../../renderer/timeMapping'
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
import { listFcpxmlSequences, parseFcpxml, type FcpxmlSequenceChoice } from './fcpxml'
import type { TimelineClip } from './timeline'
import type { TimelineImportReport, TimelineCompatibilityItem } from '../../../shared/timelineImport'

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

async function resolveTimelineInput(path: unknown): Promise<{ inputFile: string; extension: string }> {
  const extension = typeof path === 'string' && isAbsolute(path) ? extname(path).toLowerCase() : ''
  if (typeof path !== 'string' || !['.fcpxml', '.fcpxmld'].includes(extension)) {
    throw new Error('Choose a local .fcpxml, .fcpxmld bundle')
  }
  let inputFile = path
  if (extension === '.fcpxmld') {
    const bundle = await lstat(path).catch(() => null)
    if (!bundle?.isDirectory() || bundle.isSymbolicLink()) {
      throw new Error('The FCPXML bundle must be an accessible .fcpxmld directory')
    }
    inputFile = join(path, 'Info.fcpxml')
    const info = await lstat(inputFile).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error('The FCPXML bundle needs a regular Info.fcpxml file at its root')
    }
  }
  return { inputFile, extension }
}

export async function listTimelineSequences(path: unknown, deps: MediaDeps): Promise<FcpxmlSequenceChoice[]> {
  const { inputFile } = await resolveTimelineInput(path)
  return listFcpxmlSequences(await readTimelineDocument(inputFile, deps))
}

export async function prepareTimelineProject(
  path: unknown, destination: string, idGen: IdGen, deps: MediaDeps, assertCurrent: () => void,
  relinkDirectory?: unknown, sequenceIndex?: unknown,
): Promise<{ project: Project; report: TimelineImportReport }> {
  const { inputFile, extension } = await resolveTimelineInput(path)
  if (sequenceIndex !== undefined &&
      (!Number.isSafeInteger(sequenceIndex) || (sequenceIndex as number) < 0)) {
    throw new Error('Choose a valid FCPXML sequence index')
  }
  const document = await readTimelineDocument(inputFile, deps)
  const timeline = parseFcpxml(document, sequenceIndex as number | undefined)
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
  if (relinkDirectory !== undefined) {
    if (typeof relinkDirectory !== 'string' || !isAbsolute(relinkDirectory)) {
      throw new Error('Choose an absolute media folder for relinking')
    }
    const directory = await lstat(relinkDirectory).catch(() => null)
    if (!directory?.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('The selected media folder is missing or is not a regular directory')
    }
  }
  const sourcePaths = new Map(timeline.clips.map((clip) => [clip.asset.path, clip.asset.ref]))
  const missing: string[] = []
  const substitutions = new Map<string, string>()
  const claimed = new Map<string, string>()
  for (const [mediaPath, ref] of sourcePaths) {
    let actual = mediaPath
    try { importer.checkPath(actual) }
    catch {
      if (typeof relinkDirectory === 'string') {
        const candidate = join(relinkDirectory, basename(mediaPath))
        const candidateInfo = await lstat(candidate).catch(() => null)
        if (candidateInfo?.isFile() && !candidateInfo.isSymbolicLink()) {
          try { actual = importer.checkPath(candidate) } catch { /* leave missing below */ }
        }
      }
      if (actual === mediaPath) missing.push(`${ref} (${mediaPath})`)
      else substitutions.set(mediaPath, actual)
    }
    const previous = claimed.get(actual)
    if (previous !== undefined && previous !== mediaPath) {
      throw new Error(`Ambiguous media relink: ${previous} and ${mediaPath} resolve to ${actual}. Choose distinct originals and review again`)
    }
    claimed.set(actual, mediaPath)
  }
  if (missing.length) {
    const extra = missing.length > 5 ? ` and ${missing.length - 5} more` : ''
    throw new Error(`Missing or unreadable original media: ${missing.slice(0, 5).join(', ')}${extra}. Choose a folder containing the original filenames, or relink in the source editor`)
  }
  for (const clip of timeline.clips) {
    const replacement = substitutions.get(clip.asset.path)
    if (replacement) clip.asset.path = replacement
  }
  const paths = new Map(timeline.clips.map((clip) => [clip.asset.path, clip.asset.ref]))
  const relinkedMedia = [...substitutions].map(([from, to]) => ({ from, to }))

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
  let resampledAudioClips = 0
  let downmixedAudioClips = 0
  let rateConformedVideoClips = 0
  let resizedVideoClips = 0
  const videoConversions = new Map<string, TimelineImportReport['videoConversions'][number]>()
  const compatibilityItems: TimelineCompatibilityItem[] = []
  for (const clip of timeline.clips) {
    const item = itemOf(clip)
    const notes: string[] = []
    let approximation = false
    let converted = false
    const sourceOut = validateSource(clip, item)
    if (sourceOut !== clip.sourceOut) {
      roundedEnds++
      converted = true
      notes.push('Source out-point rounded to the probed file endpoint')
    }
    if (clip.asset.hasVideo && !clip.asset.stillImage && item.metadata.video) {
      const sourceVideo = item.metadata.video
      const rateConformed = sourceVideo.fps_num! * target.fps.den !== sourceVideo.fps_den! * target.fps.num
      const aspect = clip.asset.videoFormat
      const nonSquarePixels = aspect !== undefined && aspect.paspH !== aspect.paspV
      const scaledToFit = sourceVideo.width !== width || sourceVideo.height !== height || nonSquarePixels ||
        (clip.conform !== undefined && clip.conform !== 'fit')
      if (rateConformed) {
        rateConformedVideoClips++
        converted = true
        notes.push('Source-timestamp FPS conform: output may repeat or skip source frames')
        approximation = true
      }
      if (scaledToFit) {
        resizedVideoClips++
        converted = true
        notes.push(clip.conform === 'fill' ? 'Spatial conform: fill the canvas (may crop)'
          : clip.conform === 'none' ? 'Spatial conform: preserve source pixel dimensions (may crop)'
            : nonSquarePixels
              ? 'Source pixel aspect ' + aspect.paspH + ':' + aspect.paspV + ' is conformed and scaled to fit'
              : 'Source resolution is scaled uniformly to fit the canvas')
      }
      const conversionKey = item.path_abs + '|' + (clip.conform ?? 'fit')
      if ((rateConformed || scaledToFit) && !videoConversions.has(conversionKey)) {
        videoConversions.set(conversionKey, { source: item.path_abs,
          sourceWidth: sourceVideo.width!, sourceHeight: sourceVideo.height!,
          sourceFps: { num: sourceVideo.fps_num!, den: sourceVideo.fps_den! },
          pixelAspect: nonSquarePixels ? { h: aspect.paspH, v: aspect.paspV } : null,
          spatialConform: clip.conform ?? 'fit',
          rateConformed, scaledToFit })
      }
    }
    if (clip.audioRole && item.metadata.audio) {
      if (item.metadata.audio.sample_rate != null && item.metadata.audio.sample_rate !== 48_000) {
        resampledAudioClips++
        converted = true
        notes.push('Audio resampled to the 48 kHz editing mix')
      }
      if ((item.metadata.audio.channels ?? 0) > 2) {
        downmixedAudioClips++
        converted = true
        notes.push('Discrete multichannel audio downmixed to stereo')
        approximation = true
      }
    }
    if (clip.volumeDb) notes.push('Static clip gain: ' + clip.volumeDb + 'dB (editable)')
    if (clip.staticTransform) notes.push('Static position/scale/rotation (editable)')
    if (clip.opacity !== undefined && clip.opacity !== 1) {
      notes.push('Static opacity: ' + clip.opacity + ' (editable)')
    }
    compatibilityItems.push({ location: clip.location,
      label: clip.label || clip.asset.ref, lane: clip.lane,
      status: approximation ? 'approximated' : converted ? 'converted' : 'exact',
      notes })
    const track = tracks.get(laneIds.get(clip.lane)!)!
    const video = clip.asset.hasVideo && !clip.asset.stillImage
      ? newLayer(idGen, clip, sourceOut, boundary(clip.firstFrame), boundary(clip.endFrame),
        visualAdjustments(fitVideoParams(item, target, clip), clip, target))
      : null
    const image = clip.asset.stillImage
      ? newLayer(idGen, clip, sourceOut, boundary(clip.firstFrame), boundary(clip.endFrame),
        visualAdjustments(imageOverlayParams(item.id, { width, height }) as Extract<Layer['params'], { kind: 'ImageOverlay' }>,
          clip, target))
      : null
    const audio = clip.audioRole
      ? newLayer(idGen, clip, sourceOut, sampleBoundary(clip.firstFrame), sampleBoundary(clip.endFrame),
        { ...audioParams(item.id, 0, 0), role: clip.audioRole, gain_db: { mode: 'Static', value: clip.volumeDb ?? 0 } })
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
    resampledAudioClips, downmixedAudioClips,
    rateConformedVideoClips, resizedVideoClips, videoConversions: [...videoConversions.values()],
    normalizedTimecode: timeline.normalizedTimecode ?? false,
    dropFrameTimecode: timeline.dropFrameTimecode ?? false,
    namedFormatDefaults: timeline.namedFormatDefaults ?? false,
    bundleSource: extension === '.fcpxmld', relinkedMedia, compatibilityItems,
    compatibilityCounts: {
      exact: compatibilityItems.filter(i => i.status === 'exact').length,
      converted: compatibilityItems.filter(i => i.status === 'converted').length,
      approximated: compatibilityItems.filter(i => i.status === 'approximated').length,
      unsupported: 0,
    },
  } }
}

function fitVideoParams(item: MediaItem, target: Pick<ReturnType<typeof rootComposition>, 'width' | 'height'>,
  clip: TimelineClip) {
  const params = videoClipParams(item.id, 0, 0, target)
  const video = item.metadata.video
  if (video?.width && video.height) {
    const ratio = clip.asset.videoFormat
      ? clip.asset.videoFormat.paspH / clip.asset.videoFormat.paspV : 1
    const displayedWidth = video.width * ratio
    const fit = clip.conform === 'none' ? 1
      : clip.conform === 'fill'
        ? Math.max(target.width / displayedWidth, target.height / video.height)
        : Math.min(target.width / displayedWidth, target.height / video.height)
    params.transform.scale_x = { mode: 'Static', value: fit * ratio }
    params.transform.scale_y = { mode: 'Static', value: fit }
    params.transform.scale_linked = ratio === 1
  }
  return params
}

function visualAdjustments<T extends Extract<Layer['params'], { kind: 'VideoClip' | 'ImageOverlay' }>>(
  params: T, clip: TimelineClip, target: Pick<ReturnType<typeof rootComposition>, 'width' | 'height'>,
): T {
  if (clip.staticTransform) {
    const adj = clip.staticTransform
    // FCPXML offsets are percentages of FRAME height, with Y increasing
    // upward; WeftCut uses composition pixels with Y increasing downward.
    params.transform.position.x = { mode: 'Static', value:
      target.width / 2 + adj.xPercent * target.height / 100 }
    params.transform.position.y = { mode: 'Static', value:
      target.height / 2 - adj.yPercent * target.height / 100 }
    if (params.transform.scale_x.mode !== 'Static' || params.transform.scale_y.mode !== 'Static') {
      throw new Error('Imported clips require static source scale tracks')
    }
    params.transform.scale_x = { mode: 'Static', value: params.transform.scale_x.value * adj.scaleX }
    params.transform.scale_y = { mode: 'Static', value: params.transform.scale_y.value * adj.scaleY }
    // FCPXML positive rotation is counterclockwise; Pixi's angle is
    // clockwise in screen coordinates.
    params.transform.rotation_deg = { mode: 'Static', value: -adj.rotation }
  }
  params.transform.scale_linked = params.transform.scale_x.value === params.transform.scale_y.value
  if (clip.opacity !== undefined) params.opacity = { mode: 'Static', value: clip.opacity }
  return params
}

function newLayer(idGen: IdGen, clip: TimelineClip, sourceOut: ExactTime, start: number, end: number, params: Extract<Layer['params'], { kind: 'VideoClip' | 'ImageOverlay' }> | AudioParams): Layer {
  // A still image has no moving source clock. Its authored span is on the
  // composition timeline, not a range within a zero-duration image asset.
  if (params.kind !== 'ImageOverlay') writeSourceWindow(params, clip.sourceIn, sourceOut)
  return { id: idGen(), label: clip.label ?? null, t_start_us: start, t_end_us: end,
    enabled: true, locked: false, metadata: {}, params, effects: [] }
}

function validateSource(clip: TimelineClip, item: MediaItem): ExactTime {
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
    if (item.kind !== 'Video' || !video || !video.width || !video.height ||
        !video.fps_num || !video.fps_den ||
        !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) ||
        !Number.isSafeInteger(video.fps_num) || !Number.isSafeInteger(video.fps_den)) {
      fail('The original must be decodable video with known positive dimensions and frame rate')
    }
    const v = video!
    const sourceWidth = v.width!, sourceHeight = v.height!
    const sourceFpsNum = v.fps_num!, sourceFpsDen = v.fps_den!
    const declared = clip.asset.videoFormat
    const probeFrame = exactTime(1_000_000 * sourceFpsDen, sourceFpsNum)
    if (declared) {
      if (sourceWidth !== declared.width || sourceHeight !== declared.height ||
          compareTime(probeFrame, declared.frameDuration) !== 0) {
        fail('The original dimensions or frame rate differ from its FCPXML asset format. Relink the matching media')
      }
    } else if (divideTime(clip.sourceIn, probeFrame).den !== 1) {
      fail('The source in-point falls between frames at the probed source frame rate. Choose a source-frame boundary')
    }
  } else if (item.kind !== 'Audio' || video) {
    fail('The original must be an audio-only file. Relink the matching original and export again')
  }
  if ((clip.asset.hasAudio !== undefined && Boolean(audio) !== clip.asset.hasAudio) || (clip.audioRole && audio && (
    !audio.channels || audio.channels > 8 || !audio.sample_rate ||
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
