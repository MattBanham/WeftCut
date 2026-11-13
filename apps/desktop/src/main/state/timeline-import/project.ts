import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canvasSizeError } from '../../../shared/newProject'
import type { ExactTime } from '../../../shared/timeMapping'
import { affineTimeMap, compareTime, divideTime, exactTime, floorTime, multiplyTime, roundTime, subtractTime } from '../../../renderer/timeMapping'
import { splitExact, writeSourceWindow } from '../../../renderer/layerTiming'
import { createActor } from '../actor'
import { type IdGen } from '../ids'
import { createMediaImporter, type MediaImportDeps } from '../mediaImport'
import { blankProject, rootComposition, type AudioParams, type Layer, type MediaItem, type Project } from '../model'
import { applyAddTrack, DEFAULT_MARKER_COLOR } from '../mutations/add'
import { audioParams, imageOverlayParams, videoClipParams } from '../mutations/media'
import { applyDurationAutofit } from '../mutations/helpers'
import { AUDIO_GRID, timeUsAtFrame, timeUsAtGridIndex } from '../snap'
import { validate } from '../validate'
import { FCPXML_LIMITS, listFcpxmlSequences, parseFcpxml } from './fcpxml'
import type { TimelineClip, TimelineSource } from './timeline'
import type { TimelineImportReport, TimelineCompatibilityItem, TimelineMediaChange, TimelineMediaIssue, TimelineSequenceList } from '../../../shared/timelineImport'
import { originalMediaPath } from './mediaPath'

export class TimelineMediaFailure extends Error {
  constructor(readonly issues: TimelineMediaIssue[], readonly canSearchFolder = false) {
    super(issues.map(issue => issue.detail).join('\n'))
  }
}

type MediaDeps = Pick<MediaImportDeps, 'compute' | 'statPath' | 'realPath' | 'fileKey'>

async function readTimelineDocument(path: string, deps: MediaDeps): Promise<string> {
  const before = await lstat(path).catch(() => null)
  if (!before?.isFile() || before.isSymbolicLink()) throw new Error('Choose a regular timeline file, rather than a symlink or device')
  const facts = deps.statPath(path)
  if (facts?.kind !== 'file' || !facts.readable) throw new Error('The selected timeline file is missing or unreadable')
  // Nonblocking open prevents a swapped-in FIFO from hanging the editor.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error('The timeline file changed during import. Try again after the file is ready')
    }
    if (stat.size > FCPXML_LIMITS.bytes) throw new Error('Choose a regular timeline file up to 16 MiB')
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
  let inputFile = resolve(path)
  if (extension === '.fcpxmld') {
    const bundle = await lstat(inputFile).catch(() => null)
    if (!bundle?.isDirectory() || bundle.isSymbolicLink()) {
      throw new Error('The FCPXML bundle must be an accessible .fcpxmld directory')
    }
    inputFile = join(inputFile, 'Info.fcpxml')
    const info = await lstat(inputFile).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error('The FCPXML bundle needs a regular Info.fcpxml file at its root')
    }
  }
  return { inputFile, extension }
}

const documentId = (xml: string) => createHash('sha256').update(xml).digest('hex')

export async function listTimelineSequences(path: unknown, deps: MediaDeps): Promise<TimelineSequenceList> {
  const { inputFile } = await resolveTimelineInput(path)
  const xml = await readTimelineDocument(inputFile, deps)
  return { documentId: documentId(xml), choices: listFcpxmlSequences(xml) }
}

async function findRelinkCandidates(directory: string, wanted: ReadonlySet<string>): Promise<Map<string, string>> {
  const root = await realpath(directory)
  const entries = await opendir(root)
  const matches = new Map<string, string>()
  let scanned = 0
  for await (const entry of entries) {
    if (++scanned > FCPXML_LIMITS.directoryEntries) throw new Error('The relink folder contains too many entries. Choose a smaller folder containing the original files')
    if (!wanted.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue
    const candidate = join(root, entry.name)
    const actual = await realpath(candidate).catch(() => null)
    const info = await lstat(candidate).catch(() => null)
    if (actual && info?.isFile() && !info.isSymbolicLink() && relative(root, dirname(actual)) === '') {
      matches.set(entry.name, actual)
      if (matches.size === wanted.size) break
    }
  }
  return matches
}

export async function prepareTimelineProject(
  path: unknown, destination: string | null, idGen: IdGen, deps: MediaDeps, assertCurrent: () => void,
  relinkDirectory?: unknown, sequenceIndex?: unknown, existing?: Project, replacements?: unknown, expectedDocument?: unknown, omitEffects = false,
): Promise<{ project: Project; report: TimelineImportReport }> {
  const { inputFile, extension } = await resolveTimelineInput(path)
  if (sequenceIndex !== undefined &&
      (!Number.isSafeInteger(sequenceIndex) || (sequenceIndex as number) < 0)) {
    throw new Error('Choose a valid FCPXML sequence index')
  }
  const document = await readTimelineDocument(inputFile, deps)
  if (expectedDocument !== undefined && expectedDocument !== documentId(document)) {
    throw new Error('The FCPXML file changed since you opened it. Choose it again to review the updated timeline.')
  }
  const timeline = parseFcpxml(document, sequenceIndex as number | undefined, omitEffects)
  assertCurrent()
  const initial = blankProject(idGen, timeline.name?.trim() || basename(inputFile, extname(inputFile)))
  rootComposition(initial).fps = timeline.fps
  if (existing) {
    initial.media_pool = existing.media_pool
    const parent = rootComposition(existing)
    rootComposition(initial).sample_rate = parent.sample_rate
    rootComposition(initial).channels = parent.channels
  }
  const actor = createActor({ initial, idGen, clock: () => new Date().toISOString() })
  // Stage registration through the normal importer against the destination's
  // pool. Disk jobs wait for confirmation; cancellation discards this actor.
  const importer = createMediaImporter({
    ...deps, actor, workspaceDir: () => destination,
    enqueueDerivatives: async () => {}, enqueueWorkspaceCopy: async () => {},
  })
  let relinkRoot: string | undefined
  if (relinkDirectory !== undefined) {
    if (typeof relinkDirectory !== 'string' || !isAbsolute(relinkDirectory)) {
      throw new Error('Choose an absolute media folder for relinking')
    }
    relinkRoot = resolve(relinkDirectory)
    const directory = await lstat(relinkRoot).catch(() => null)
    if (!directory?.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('The selected media folder is missing or is not a regular directory')
    }
  }
  const originals = new Map(timeline.clips.map(({ asset }) => [asset.path, asset]))
  const references = new Map(timeline.clips.map(({ asset }) => [asset.ref, asset.path]))
  const counts = new Map<string, number>()
  for (const { asset } of timeline.clips) counts.set(asset.path, (counts.get(asset.path) ?? 0) + 1)
  const mediaIssue = (asset: TimelineSource, detail: string): TimelineMediaIssue => ({
    assetRef: asset.ref, filename: asset.filename, sourcePath: asset.path, placements: counts.get(asset.path)!, detail,
  })
  if (originals.size > FCPXML_LIMITS.mediaFiles) {
    throw new Error('This sequence references too many original files. Export the sequence in smaller parts')
  }
  const selected = new Map<string, string>()
  if (replacements !== undefined) {
    if (!Array.isArray(replacements) || replacements.length > originals.size) {
      throw new Error('Choose at most one replacement per source file')
    }
    for (const choice of replacements) {
      if (!choice || typeof choice.assetRef !== 'string' || typeof choice.path !== 'string' || !isAbsolute(choice.path)) {
        throw new Error('Choose a local replacement file for each source')
      }
      const original = references.get(choice.assetRef)
      if (original === undefined || selected.has(original)) {
        throw new Error('The replacement does not identify a unique source in this sequence')
      }
      // Check the spelling before any filesystem access, just as for URLs in XML.
      selected.set(original, originalMediaPath(pathToFileURL(choice.path).href).path)
    }
  }

  async function checkFile(path: string): Promise<string> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Choose a regular file')
    const actual = await realpath(path)
    originalMediaPath(pathToFileURL(actual).href)
    return importer.checkPath(actual)
  }

  const resolved = new Map<string, string>()
  const offline: TimelineSource[] = []
  const substitutions = new Map<string, string>()
  const missing: TimelineMediaIssue[] = []
  for (const asset of originals.values()) {
    const replacement = selected.get(asset.path)
    if (replacement !== undefined) {
      try {
        const path = await checkFile(replacement)
        resolved.set(asset.path, path)
        substitutions.set(asset.path, path)
      } catch {
        missing.push(mediaIssue(asset, 'The chosen replacement is missing or unreadable. Choose another local file.'))
      }
    } else if (asset.local) {
      try { resolved.set(asset.path, await checkFile(asset.path)) }
      catch { offline.push(asset) }
    } else {
      offline.push(asset)
    }
  }
  const candidates = relinkRoot && offline.length
    ? await findRelinkCandidates(relinkRoot, new Set(offline.map(asset => asset.filename)))
    : new Map<string, string>()
  for (const asset of offline) {
    const candidate = candidates.get(asset.filename)
    if (candidate) {
      try {
        const path = await checkFile(candidate)
        resolved.set(asset.path, path)
        substitutions.set(asset.path, path)
        continue
      } catch { /* Leave this asset unresolved. */ }
    }
    missing.push(mediaIssue(asset, 'Missing or unreadable original media: ' + asset.path +
      (asset.local ? '' : ' (path is from another platform)') + '. Choose the original file or look for it in a folder.'))
  }
  const claimed = new Map<string, string>()
  const conflicts = new Map<string, TimelineMediaIssue>()
  for (const [original, actual] of resolved) {
    const key = deps.fileKey?.(actual) ?? deps.realPath?.(actual) ?? actual
    const previous = claimed.get(key)
    if (previous !== undefined && (substitutions.has(original) || substitutions.has(previous))) {
      for (const path of [previous, original]) {
        conflicts.set(path, mediaIssue(originals.get(path)!, 'Ambiguous media relink: two sources point to ' +
          actual + '. Choose distinct originals.'))
      }
    }
    claimed.set(key, previous ?? original)
  }
  if (conflicts.size) throw new TimelineMediaFailure([...missing, ...conflicts.values()], offline.length > 0)

  const relinkedMedia = [...substitutions].filter(([from, to]) => from !== to).map(([from, to]) => ({ from, to }))
  const mediaIds = new Map<string, string>()
  const failed: TimelineMediaIssue[] = []
  for (const [original, mediaPath] of resolved) {
    assertCurrent()
    const asset = originals.get(original)!
    try {
      const result = await importer.ensureImported(mediaPath)
      if (result.disposition === 'relinked' && existing?.media_pool[result.mediaId]) {
        throw new Error('An existing pool item needs repair. Relink it through the media pool before reviewing this timeline')
      }
      mediaIds.set(original, result.mediaId)
    } catch (error) {
      assertCurrent()
      failed.push(mediaIssue(asset, 'Could not read ' + mediaPath + '. Choose another file or export a compatible copy. ' +
        (error instanceof Error ? error.message : String(error))))
    }
  }
  assertCurrent()
  const snapshot = actor.snapshot()
  const root = rootComposition(snapshot)
  const itemOf = (clip: TimelineClip) => snapshot.media_pool[mediaIds.get(clip.asset.path)!]!
  const sourceEnds = new Map<TimelineClip, ExactTime>()
  const mediaChanges = new Map<string, TimelineMediaChange>()
  const incompatibilities = new Map<string, TimelineMediaIssue>()
  for (const clip of timeline.clips) {
    const item = itemOf(clip)
    if (!item) continue
    try {
      const result = validateSource(clip, item)
      sourceEnds.set(clip, result.end)
      for (const { kind, detail } of result.changes) {
        const issue = mediaIssue(originals.get(clip.asset.path)!, detail)
        mediaChanges.set(JSON.stringify([clip.asset.path, kind, detail]), { ...issue, kind, sourcePath: item.path_abs })
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const key = JSON.stringify([clip.asset.path, detail])
      incompatibilities.set(key, mediaIssue(originals.get(clip.asset.path)!, detail))
    }
  }
  if (missing.length || failed.length || incompatibilities.size) {
    throw new TimelineMediaFailure([...missing, ...failed, ...incompatibilities.values()], offline.length > 0)
  }
  const video = timeline.canvas ? null : itemOf(timeline.clips[0]!).metadata.video
  const width = timeline.canvas?.width ?? video?.width ?? 0
  const height = timeline.canvas?.height ?? video?.height ?? 0
  if (canvasSizeError(width, height)) throw new Error('The original media must have a supported even-sized WeftCut canvas')
  const target = { ...root, width, height, tracks: root.tracks.map((track) => ({ ...track, layers: [] as Layer[] })),
    links: [...root.links], markers: [...root.markers] }
  const usedMedia = new Set(mediaIds.values())
  const project = { ...snapshot,
    media_pool: Object.fromEntries(Object.entries(snapshot.media_pool).filter(([id]) => usedMedia.has(id))),
    compositions: { ...snapshot.compositions, [root.id]: target } }
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
  const samplesPerUs = exactTime(AUDIO_GRID.num, 1_000_000)
  const sequenceEnd = boundary(timeline.durationFrames)
  const sampleBoundary = (time: ExactTime) => {
    const sample = multiplyTime(time, samplesPerUs)
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
  const visualLayers = new Map<TimelineClip, Layer>()
  const compatibilityItems: TimelineCompatibilityItem[] = [...timeline.notices]
  for (const clip of timeline.clips) {
    const item = itemOf(clip)
    const notes = [...clip.notes]
    let approximation = false
    let converted = notes.length > 0
    const adjustment = (value: ExactTime) => (value.num / value.den).toFixed(6).replace(/\.?0+$/, '')
    const audioStart = sampleBoundary(clip.timelineStart)
    const audioEnd = sampleBoundary(clip.timelineEnd)
    if (clip.audioRole) {
      if (audioEnd <= audioStart) {
        throw new Error(clip.location + ': This audio clip is too short to occupy a 48 kHz sample. Extend it in the source editor and export again.')
      }
      for (const [label, time, snapped] of [['start', clip.timelineStart, audioStart], ['end', clip.timelineEnd, audioEnd]] as const) {
        const delta = subtractTime(exactTime(snapped), time)
        if (delta.num !== 0) {
          notes.push('Audio ' + label + ' quantized to the 48 kHz sample grid: ' + adjustment(delta) + ' µs')
          converted = true
        }
      }
    }
    if (clip.markers.length && clip.asset.stillImage) {
      converted = true
      notes.push('Still-image markers keep their timeline positions as independent markers')
    }
    if (clip.asset.stillImage) {
      converted = true
      notes.push('Still image uses ' + (clip.conform ?? 'fit') + ' spatial conform from its original dimensions to the sequence canvas')
    }
    const sourceOut = sourceEnds.get(clip)!
    if (sourceOut !== clip.sourceOut) {
      roundedEnds++
      converted = true
      notes.push('Source out-point rounded to the probed file endpoint: ' + adjustment(subtractTime(sourceOut, clip.sourceOut)) + ' µs')
    }
    if (clip.hasVideo && !clip.asset.stillImage && item.metadata.video) {
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
    const video = clip.hasVideo && !clip.asset.stillImage
      ? newLayer(idGen, clip, sourceOut, boundary(clip.firstFrame), boundary(clip.endFrame),
        visualAdjustments(fitVideoParams(item, target, clip), clip, target))
      : null
    const image = clip.asset.stillImage
      ? newLayer(idGen, clip, sourceOut, boundary(clip.firstFrame), boundary(clip.endFrame),
        visualAdjustments(fitVisualParams(imageOverlayParams(item.id, { width, height }) as Extract<Layer['params'], { kind: 'ImageOverlay' }>, item, target, clip), clip, target))
      : null
    const audio = clip.audioRole
      ? newLayer(idGen, clip, sourceOut, audioStart, audioEnd,
        { ...audioParams(item.id, 0, 0), role: clip.audioRole, gain_db: { mode: 'Static', value: clip.volumeDb ?? 0 } })
      : null
    if (video || image) {
      const layer = (video ?? image)!
      track.layers.push(layer)
      visualLayers.set(clip, layer)
      videoClips++
    }
    if (audio) { track.layers.push(audio); audioClips++ }
    if (video && audio) target.links.push({ id: idGen(), members: [video.id, audio.id].sort() })
    for (const mark of clip.markers) {
      const { whole, fraction } = splitExact(mark.source)
      target.markers.push({
        id: idGen(), t_us: boundary(mark.frame), end_t_us: mark.endFrame === null ? null : boundary(mark.endFrame),
        label: mark.label, note: '', color: DEFAULT_MARKER_COLOR,
        anchor: image ? null : { layer: (video ?? audio)!.id, src_us: whole, ...(fraction.num ? { src_fraction: fraction } : {}) },
      })
    }
  }
  for (const dissolve of timeline.dissolves ?? []) {
    target.transitions.push({
      id: idGen(), from_layer: visualLayers.get(dissolve.from)!.id, to_layer: visualLayers.get(dissolve.to)!.id,
      duration_us: boundary(dissolve.endFrame) - boundary(dissolve.firstFrame), kind: { kind: 'Crossfade' }, extended_us: 0,
    })
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
    outputColorChange: timeline.sourceColor && videoClips ? timeline.sourceColor : null,
    mediaChanges: [...mediaChanges.values()], omittedEffects: timeline.omittedEffects ?? [],
    videoClips, audioClips, markers: target.markers.length, media: Object.keys(project.media_pool).length,
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
  return fitVisualParams(videoClipParams(item.id, 0, 0, target), item, target, clip)
}

function fitVisualParams<T extends Extract<Layer['params'], { kind: 'VideoClip' | 'ImageOverlay' }>>(
  params: T, item: MediaItem, target: Pick<ReturnType<typeof rootComposition>, 'width' | 'height'>,
  clip: TimelineClip,
): T {
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
  if (params.kind !== 'ImageOverlay') {
    writeSourceWindow(params, clip.sourceIn, sourceOut)
    if (clip.playbackRate) params.time_map = affineTimeMap(clip.playbackRate)
    if (params.kind === 'Audio' && clip.preservePitch !== undefined) params.preserve_pitch = clip.preservePitch
  }
  return { id: idGen(), label: clip.label ?? null, t_start_us: start, t_end_us: end,
    enabled: clip.enabled ?? true, locked: false, metadata: {}, params, effects: [] }
}

function validateSource(clip: TimelineClip, item: MediaItem) {
  const { video, audio, duration_us: duration } = item.metadata
  const fail = (message: string): never => { throw new Error(message) }
  const changes: Pick<TimelineMediaChange, 'kind' | 'detail'>[] = []
  const reportSize = (kind: 'still-size' | 'video-size', declared: { width: number; height: number }) => {
    if (video!.width === declared.width && video!.height === declared.height) return
    changes.push({ kind, detail: 'The timeline lists ' + declared.width + ' × ' + declared.height +
      ' pixels, but this file is ' + video!.width + ' × ' + video!.height +
      '. WeftCut can use the file’s actual size. This may change the framing.' })
  }
  const withEnd = (end: ExactTime) => ({ end, changes })
  const transfer = video?.color_transfer
  const primaries = video?.color_primaries
  if (clip.hasVideo && ((transfer != null && transfer !== 'bt709' && transfer !== 'iec61966-2-1') ||
      (primaries != null && primaries !== 'bt709'))) {
    fail('WeftCut cannot match this file’s HDR or wide-gamut colors. The file has an unsupported color transfer or gamut (' +
      (transfer ?? 'unspecified transfer') + ', ' + (primaries ?? 'unspecified primaries') +
      '). Export an SDR Rec. 709 copy with the same timing, then choose it as the replacement.')
  }
  if (clip.hasVideo && clip.asset.sourceColor !== undefined) {
    // An explicitly tagged SDR copy is evidence that the XML's color
    // declaration can be set aside. An untagged file cannot prove this.
    if (primaries !== 'bt709' || (transfer !== 'bt709' && transfer !== 'iec61966-2-1')) {
      fail('The timeline describes this file as ' + clip.asset.sourceColor +
        '. Export an SDR Rec. 709 copy with color tags and the same timing, then choose it as the replacement.')
    }
    changes.push({ kind: 'color-format', detail: 'The timeline describes this file as ' + clip.asset.sourceColor +
      ', but the selected file is tagged SDR Rec. 709. WeftCut can use its SDR colors and keep the cut times.' })
  }
  if (clip.asset.stillImage) {
    // The normal image probe may report width/height in metadata.video even
    // though the media is an Image, not a moving VideoClip. Image kind is the
    // authoritative distinction; a real audio stream remains unsupported.
    if (item.kind !== 'Image' || audio) {
      fail('A zero-duration FCPXML still image must reference original image media without audio')
    }
    if (!video?.width || !video.height || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) ||
        video.width < 1 || video.height < 1) fail('The image dimensions must be known and positive')
    if (clip.asset.imageSize) reportSize('still-size', clip.asset.imageSize)
    return withEnd(clip.sourceOut)
  }
  if (clip.hasVideo) {
    if (item.kind !== 'Video' || !video || !video.width || !video.height ||
        !video.fps_num || !video.fps_den ||
        !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) ||
        !Number.isSafeInteger(video.fps_num) || !Number.isSafeInteger(video.fps_den)) {
      fail('The original must be decodable video with known positive dimensions and frame rate')
    }
    const v = video!
    const sourceFpsNum = v.fps_num!, sourceFpsDen = v.fps_den!
    const declared = clip.asset.videoFormat
    const probeFrame = exactTime(1_000_000 * sourceFpsDen, sourceFpsNum)
    if (declared) {
      if (compareTime(probeFrame, declared.frameDuration) !== 0) {
        if (divideTime(clip.sourceIn, probeFrame).den !== 1) {
          fail('The file’s frame rate differs from its FCPXML asset format, and this cut starts between its frames. Choose the original or export a replacement at the original rate.')
        }
        const declaredRate = divideTime(exactTime(1_000_000), declared.frameDuration)
        changes.push({ kind: 'video-rate', detail: 'The timeline lists ' + declaredRate.num + '/' + declaredRate.den +
          ' fps, but this file is ' + sourceFpsNum + '/' + sourceFpsDen +
          ' fps. WeftCut will keep the cut times. The picture may repeat or skip frames.' })
      }
      reportSize('video-size', declared)
    } else if (divideTime(clip.sourceIn, probeFrame).den !== 1) {
      fail('The source in-point falls between frames at the probed source frame rate. Choose a source-frame boundary')
    }
  } else if ((item.kind !== 'Audio' && item.kind !== 'Video') || (!clip.asset.hasVideo && video)) {
    fail('The file does not contain the type of audio the timeline requests. Choose the matching original.')
  }
  if (clip.audioRole && (!audio?.channels || audio.channels > 8 || !audio.sample_rate)) {
    fail('The timeline needs usable audio from this file. Choose a matching original with 1–8 audio channels.')
  }
  if (audio && !clip.asset.hasAudio) {
    changes.push({ kind: 'audio-format', detail: 'This file contains audio the timeline did not request. WeftCut will leave that audio out.' })
  }
  if (audio && clip.audioRole && (
    (clip.asset.audioChannels !== undefined && clip.asset.audioChannels !== audio.channels) ||
    (clip.asset.audioRate !== undefined && clip.asset.audioRate !== audio.sample_rate)
  )) {
    changes.push({ kind: 'audio-format', detail: 'The file’s audio differs from the timeline description. The file has ' +
      audio.channels + ' channel(s) at ' + audio.sample_rate + ' Hz. The timeline lists ' +
      (clip.asset.audioChannels ?? 'an unspecified number of') + ' channel(s) and ' +
      (clip.asset.audioRate === undefined ? 'does not specify a sample rate' : clip.asset.audioRate + ' Hz') +
      '. WeftCut will use the audio in the file and keep the edit’s timing.' })
  }
  if (duration != null) {
    const end = exactTime(duration)
    if (compareTime(clip.sourceOut, end) <= 0) return withEnd(clip.sourceOut)
    // ffprobe reports duration to whole microseconds. At fractional rates the
    // final exclusive frame boundary can round down to this same endpoint.
    if (roundTime(clip.sourceOut) === duration && compareTime(clip.sourceIn, end) < 0) return withEnd(end)
  }
  return fail('The trim exceeds the probed duration of the original file. Relink the matching original or shorten the trim')
}
