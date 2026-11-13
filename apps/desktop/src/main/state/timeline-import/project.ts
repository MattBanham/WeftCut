import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canvasSizeError } from '../../../shared/newProject'
import type { ExactTime } from '../../../shared/timeMapping'
import { affineTimeMap, compareTime, divideTime, exactTime, floorTime, multiplyTime, roundTime, subtractTime } from '../../../renderer/timeMapping'
import { splitExact, writeSourceWindow } from '../../../renderer/layerTiming'
import { ffprobeColorToWebCodecs } from '../../../renderer/render/decoder/ffprobeColorSpace'
import { createActor } from '../actor'
import { type IdGen } from '../ids'
import { createMediaImporter, type MediaImportDeps } from '../mediaImport'
import { blankProject, newComposition, rootComposition, type AudioParams, type Composition, type CompositionRefParams, type Layer, type MediaItem, type Project } from '../model'
import { applyAddTrack, DEFAULT_MARKER_COLOR, defaultTransform } from '../mutations/add'
import { audioParams, imageOverlayParams, videoClipParams } from '../mutations/media'
import { applyDurationAutofit } from '../mutations/helpers'
import { AUDIO_GRID, timeUsAtFrame, timeUsAtGridIndex } from '../snap'
import { validate } from '../validate'
import { FCPXML_LIMITS, listFcpxmlSequences, parseFcpxml, TimelineEditFailure } from './fcpxml'
import type { ImportTimeline, TimelineClip, TimelineSource, TimelineSourceWindow } from './timeline'
import type { TimelineImportReport, TimelineCompatibilityItem, TimelineMediaChange, TimelineMediaIssue, TimelineSequenceList } from '../../../shared/timelineImport'
import { originalMediaPath } from './mediaPath'

export class TimelineMediaFailure extends Error {
  constructor(
    readonly issues: TimelineMediaIssue[],
    readonly canSearchFolder: boolean,
    readonly editIssues: TimelineCompatibilityItem[],
    readonly mediaChanges: TimelineMediaChange[] = [],
  ) {
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

function comparableFilename(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

async function findRelinkCandidates(directory: string, wanted: ReadonlySet<string>): Promise<{
  exact: Map<string, string>; suggestions: Map<string, string[]>
}> {
  const root = await realpath(directory)
  const entries = await opendir(root)
  const exact = new Map<string, string>()
  const suggestions = new Map<string, string[]>()
  const wantedNames = new Set([...wanted].map(comparableFilename))
  const maxSuggestions = 5
  let scanned = 0
  for await (const entry of entries) {
    if (++scanned > FCPXML_LIMITS.directoryEntries) throw new Error('The relink folder contains too many entries. Choose a smaller folder containing the original files')
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const key = comparableFilename(entry.name)
    if (!wantedNames.has(key)) continue
    const isExact = wanted.has(entry.name)
    const matches = suggestions.get(key) ?? []
    if (!isExact && matches.length > maxSuggestions) continue
    const candidate = join(root, entry.name)
    const actual = await realpath(candidate).catch(() => null)
    const info = await lstat(candidate).catch(() => null)
    if (!actual || !info?.isFile() || info.isSymbolicLink() || relative(root, dirname(actual)) !== '') continue
    if (isExact) exact.set(entry.name, actual)
    if (matches.length <= maxSuggestions) suggestions.set(key, [...matches, actual])
    if (exact.size === wanted.size) break
  }
  for (const [key, matches] of suggestions) {
    if (matches.length > maxSuggestions) suggestions.delete(key)
    else matches.sort()
  }
  return { exact, suggestions }
}

export async function prepareTimelineProject(
  path: unknown, destination: string | null, idGen: IdGen, deps: MediaDeps, assertCurrent: () => void,
  relinkDirectory?: unknown, sequenceIndex?: unknown, existing?: Project, replacements?: unknown, expectedDocument?: unknown, omitEffects = false, leaveTitleGaps = false,
): Promise<{ project: Project; report: TimelineImportReport; assertDocumentUnchanged: () => Promise<void> }> {
  const { inputFile, extension } = await resolveTimelineInput(path)
  if (sequenceIndex !== undefined &&
      (!Number.isSafeInteger(sequenceIndex) || (sequenceIndex as number) < 0)) {
    throw new Error('Choose a valid FCPXML sequence index')
  }
  const document = await readTimelineDocument(inputFile, deps)
  const reviewedDocumentId = documentId(document)
  if (expectedDocument !== undefined && expectedDocument !== reviewedDocumentId) {
    throw new Error('The FCPXML file changed since you opened it. Choose it again to review the updated timeline.')
  }
  const timeline = parseFcpxml(document, sequenceIndex as number | undefined, omitEffects ? 'omit' : 'inspect', leaveTitleGaps)
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
  const probed = new Map<string, MediaItem['metadata']>()
  const importer = createMediaImporter({
    ...deps, actor, workspaceDir: () => destination,
    compute: {
      ...deps.compute,
      async probeMedia(path) {
        const json = await deps.compute.probeMedia(path)
        probed.set(path, (JSON.parse(json) as MediaItem).metadata)
        return json
      },
    },
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
  const sequences = new Set<ImportTimeline>()
  const multicamSequences = new Set<ImportTimeline>()
  function visit(sequence: ImportTimeline): void {
    if (sequences.has(sequence)) return
    sequences.add(sequence)
    for (const group of sequence.groups) {
      if (group.kind === 'multicam') multicamSequences.add(group.timeline)
      visit(group.timeline)
    }
  }
  visit(timeline)
  const clips = [...sequences].flatMap(sequence => sequence.clips)
  const editIssues = [...sequences].flatMap(sequence => sequence.editIssues ?? [])
  const originals = new Map<string, { asset: TimelineSource; label: string; placements: number }>()
  for (const clip of clips) {
    const { asset } = clip
    const original = originals.get(asset.ref)
    if (original) original.placements++
    else originals.set(asset.ref, { asset, label: asset.name || clip.label || asset.ref, placements: 1 })
  }
  const mediaIssue = (asset: TimelineSource, detail: string): TimelineMediaIssue => {
    const { label, placements } = originals.get(asset.ref)!
    return { assetRef: asset.ref, label, filename: asset.filename, sourcePath: asset.path, placements, detail }
  }
  const localProxies = (asset: TimelineSource) => [...new Set(asset.proxies?.filter(proxy => proxy.local).map(proxy => proxy.path) ?? [])].slice(0, 5)
  const replacementIssue = (asset: TimelineSource, detail: string, exclude?: string): TimelineMediaIssue => {
    const proxyPaths = localProxies(asset).filter(path => path !== exclude && path !== asset.path)
    return { ...mediaIssue(asset, detail), ...(proxyPaths.length ? { proxyPaths } : {}) }
  }
  if (originals.size > FCPXML_LIMITS.mediaFiles) {
    throw new Error('This sequence references too many media assets. Export the sequence in smaller parts')
  }
  const selected = new Map<string, string>()
  if (replacements !== undefined) {
    if (!Array.isArray(replacements) || replacements.length > originals.size) {
      throw new Error('Choose at most one replacement per media asset')
    }
    for (const choice of replacements) {
      if (!choice || typeof choice.assetRef !== 'string' || typeof choice.path !== 'string' || !isAbsolute(choice.path)) {
        throw new Error('Choose a local replacement file for each source')
      }
      if (!originals.has(choice.assetRef) || selected.has(choice.assetRef)) {
        throw new Error('The replacement does not identify a unique asset in this sequence')
      }
      // Check the spelling before any filesystem access, just as for URLs in XML.
      selected.set(choice.assetRef, originalMediaPath(pathToFileURL(choice.path).href).path)
    }
  }

  async function checkFile(path: string): Promise<string> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Choose a regular file')
    const actual = await realpath(path)
    originalMediaPath(pathToFileURL(actual).href)
    return importer.checkPath(actual)
  }

  const resolved = new Map<string, { path: string; choice: 'original' | 'selected' | 'folder' }>()
  const offline: TimelineSource[] = []
  const missing: TimelineMediaIssue[] = []
  const checkedPaths = new Map<string, Promise<string>>()
  for (const { asset } of originals.values()) {
    const replacement = selected.get(asset.ref)
    const candidate = replacement ?? (asset.local ? asset.path : undefined)
    if (candidate !== undefined) {
      const checked = checkedPaths.get(candidate) ?? checkFile(candidate)
      checkedPaths.set(candidate, checked)
      try {
        resolved.set(asset.ref, { path: await checked, choice: replacement === undefined ? 'original' : 'selected' })
        continue
      } catch {
        if (replacement !== undefined) {
          missing.push(replacementIssue(asset, 'The chosen replacement is missing or unreadable. Choose another local file.', replacement))
          continue
        }
      }
    }
    offline.push(asset)
  }
  const candidates = relinkRoot && offline.length
    ? await findRelinkCandidates(relinkRoot, new Set(offline.map(asset => asset.filename)))
    : undefined
  for (const asset of offline) {
    const candidate = candidates?.exact.get(asset.filename)
    if (candidate !== undefined) {
      const checked = checkedPaths.get(candidate) ?? checkFile(candidate)
      checkedPaths.set(candidate, checked)
      try {
        resolved.set(asset.ref, { path: await checked, choice: 'folder' })
        continue
      } catch { /* Leave this asset unresolved. */ }
    }
    const issue = replacementIssue(asset, 'Missing or unreadable original media: ' + asset.path +
      (asset.local ? '' : ' (path is from another platform)') + '. Choose the original file or look for it in a folder.')
    const suggestions = candidates?.suggestions.get(comparableFilename(asset.filename))?.filter(path => path !== candidate)
    if (suggestions?.length) issue.suggestedPaths = suggestions
    missing.push(issue)
  }

  const fileKeys = new Map<string, string>()
  const originalPathsByFile = new Map<string, Set<string>>()
  for (const [ref, { path }] of resolved) {
    const key = fileKeys.get(path) ?? deps.fileKey?.(path) ?? deps.realPath?.(path) ?? path
    fileKeys.set(path, key)
    const originalsForFile = originalPathsByFile.get(key) ?? new Set<string>()
    originalsForFile.add(originals.get(ref)!.asset.path)
    originalPathsByFile.set(key, originalsForFile)
  }
  for (const [ref, { path, choice }] of resolved) {
    if (choice !== 'folder' || originalPathsByFile.get(fileKeys.get(path)!)!.size <= 1) continue
    missing.push({ ...replacementIssue(originals.get(ref)!.asset, 'Ambiguous media relink. More than one original matches this file. Choose the file for this asset.'),
      suggestedPaths: [path] })
    resolved.delete(ref)
  }

  const relinkedMedia: TimelineImportReport['relinkedMedia'] = []
  const mediaIds = new Map<string, string>()
  const failed: TimelineMediaIssue[] = []
  const importedPaths = new Map<string, ReturnType<typeof importer.ensureImported>>()
  for (const [ref, { path: mediaPath, choice }] of resolved) {
    assertCurrent()
    const { asset, label } = originals.get(ref)!
    try {
      const imported = importedPaths.get(mediaPath) ?? importer.ensureImported(mediaPath)
      importedPaths.set(mediaPath, imported)
      const result = await imported
      if (result.disposition === 'relinked' && existing?.media_pool[result.mediaId]) {
        throw new Error('An existing pool item needs repair. Relink it through the media pool before reviewing this timeline')
      }
      mediaIds.set(ref, result.mediaId)
      if (choice !== 'original' && asset.path !== mediaPath) relinkedMedia.push({ assetRef: ref, label, from: asset.path, to: mediaPath })
    } catch (error) {
      assertCurrent()
      failed.push(replacementIssue(asset, 'Could not read ' + mediaPath + '. Choose another file or export a compatible copy. ' +
        (error instanceof Error ? error.message : String(error)), selected.get(ref)))
    }
  }
  assertCurrent()
  const snapshot = actor.snapshot()
  const root = rootComposition(snapshot)
  const itemOf = (clip: TimelineClip) => snapshot.media_pool[mediaIds.get(clip.asset.ref)!]!
  const sourceEnds = new Map<TimelineClip, { videoEnd: ExactTime; audioEnd: ExactTime }>()
  const mediaChanges = new Map<string, TimelineMediaChange>()
  for (const [ref, { path, choice }] of resolved) {
    const { asset } = originals.get(ref)!
    const chosen = selected.get(ref) ?? path
    if (choice === 'original' || !mediaIds.has(ref) || !asset.proxies?.some(proxy => proxy.local && (proxy.path === chosen || proxy.path === path))) continue
    const kind = 'proxy-source'
    const issue = mediaIssue(asset, 'The selected file is a proxy. WeftCut will use this copy for editing and export. ' +
      'It may have lower picture or sound quality. The original cut times stay in place.')
    mediaChanges.set(JSON.stringify([ref, kind]), { ...issue, kind, sourcePath: path })
  }
  const incompatibilities = new Map<string, TimelineMediaIssue>()
  for (const clip of clips) {
    const item = itemOf(clip)
    if (!item) continue
    try {
      const result = validateSource(clip, item, probed.get(resolved.get(clip.asset.ref)!.path))
      sourceEnds.set(clip, result)
      for (const { kind, detail } of result.changes) {
        const issue = mediaIssue(clip.asset, detail)
        mediaChanges.set(JSON.stringify([clip.asset.ref, kind, detail]), { ...issue, kind, sourcePath: item.path_abs })
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const key = JSON.stringify([clip.asset.ref, detail])
      incompatibilities.set(key, replacementIssue(clip.asset, detail, selected.get(clip.asset.ref)))
    }
  }
  if (missing.length || failed.length || incompatibilities.size) {
    throw new TimelineMediaFailure([...missing, ...failed, ...incompatibilities.values()], offline.length > 0, editIssues,
      [...mediaChanges.values()])
  }
  if (editIssues.length) throw new TimelineEditFailure(editIssues, editIssues.some(issue => issue.recovery === 'omit-effect'), [...mediaChanges.values()])
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
  let videoClips = 0
  let audioClips = 0
  let roundedEnds = 0
  let resampledAudioClips = 0
  let downmixedAudioClips = 0
  let rateConformedVideoClips = 0
  let resizedVideoClips = 0
  const videoConversions = new Map<string, TimelineImportReport['videoConversions'][number]>()
  const compatibilityItems: TimelineCompatibilityItem[] = [...sequences].flatMap(sequence => sequence.notices)
  const built = new Map<ImportTimeline, Composition>([[timeline, target]])
  const allLanes = [...new Set(clips.map(clip => clip.lane).concat(timeline.groups.length ? [0] : []))].sort((a, b) => a - b)

  function mapSequence(sequence: ImportTimeline, target: Composition): void {
    const laneIds = new Map([[0, target.tracks[0]!.id]])
    const lanes = [...new Set(sequence.clips.map((clip) => clip.lane))].sort((a, b) => a - b)
    let lowerTracks = 0
    let firstOverlay = true
    for (const lane of lanes) {
      if (lane < 0) laneIds.set(lane, applyAddTrack(project, idGen, null, lowerTracks++, target.id))
      if (lane > 0) {
        laneIds.set(lane, firstOverlay ? target.tracks[lowerTracks + 1]!.id : applyAddTrack(project, idGen, null, undefined, target.id))
        firstOverlay = false
      }
    }
    const tracks = new Map(target.tracks.map((track) => [track.id, track]))
    const boundary = (frame: number) => timeUsAtFrame(frame, target.fps.num, target.fps.den)
    const samplesPerUs = exactTime(AUDIO_GRID.num, 1_000_000)
    const sequenceEnd = boundary(sequence.durationFrames)
    const sampleBoundary = (time: ExactTime) => {
      const sample = multiplyTime(time, samplesPerUs)
      const nearest = timeUsAtGridIndex(roundTime(sample), AUDIO_GRID)
      // A terminal sample boundary past the last frame would extend the project
      // by a whole frame when WeftCut fits its duration to the last clip.
      return nearest <= sequenceEnd ? nearest : timeUsAtGridIndex(floorTime(sample), AUDIO_GRID)
    }
    const visualLayers = new Map<TimelineClip, Layer>()
    const splitLayers: Layer[] = []
    for (const clip of sequence.clips) {
      const item = itemOf(clip)
      const notes = [...clip.notes]
      let approximation = false
      let converted = notes.length > 0
      const adjustment = (value: ExactTime) => (value.num / value.den).toFixed(6).replace(/\.?0+$/, '')
      const audioWindow = clip.splitAudio ?? clip
      const audioStart = sampleBoundary(audioWindow.timelineStart)
      const audioEnd = sampleBoundary(audioWindow.timelineEnd)
      if (clip.audioRole) {
        if (audioEnd <= audioStart) {
          throw new Error(clip.location + ': This audio clip is too short to occupy a 48 kHz sample. Extend it in the source editor and export again.')
        }
        for (const [label, time, snapped] of [['start', audioWindow.timelineStart, audioStart], ['end', audioWindow.timelineEnd, audioEnd]] as const) {
          const delta = subtractTime(exactTime(snapped), time)
          if (delta.num !== 0) {
            notes.push('Audio ' + label + ' quantized to the 48 kHz sample grid: ' + adjustment(delta) + ' µs')
            converted = true
          }
        }
      }
      if (clip.markers.length && (clip.asset.stillImage || (!clip.hasVideo && clip.splitAudio))) {
        converted = true
        notes.push(clip.asset.stillImage ? 'Still-image markers keep their timeline positions as independent markers'
          : 'Markers on split audio keep their original timeline positions as independent markers')
      }
      if (clip.asset.stillImage) {
        converted = true
        notes.push('Still image uses ' + (clip.conform ?? 'fit') + ' spatial conform from its original dimensions to the sequence canvas')
      }
      const { videoEnd, audioEnd: audioSourceEnd } = sourceEnds.get(clip)!
      const videoEndRounded = clip.hasVideo && videoEnd !== clip.sourceOut
      const audioEndRounded = clip.audioRole !== null && audioSourceEnd !== audioWindow.sourceOut
      if (videoEndRounded || audioEndRounded) {
        roundedEnds++
        converted = true
        if (videoEndRounded) notes.push('Video source out-point rounded to the probed file endpoint: ' +
          adjustment(subtractTime(videoEnd, clip.sourceOut)) + ' µs')
        if (audioEndRounded) notes.push('Audio source out-point rounded to the probed file endpoint: ' +
          adjustment(subtractTime(audioSourceEnd, audioWindow.sourceOut)) + ' µs')
      }
      if (clip.hasVideo && !clip.asset.stillImage && item.metadata.video) {
        const sourceVideo = item.metadata.video
        const rateConformed = sourceVideo.fps_num! * target.fps.den !== sourceVideo.fps_den! * target.fps.num
        const aspect = clip.asset.videoFormat
        const nonSquarePixels = aspect !== undefined && aspect.paspH !== aspect.paspV
        const scaledToFit = sourceVideo.width !== target.width || sourceVideo.height !== target.height || nonSquarePixels ||
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
        ? newLayer(idGen, clip, clip.sourceIn, videoEnd, boundary(clip.firstFrame), boundary(clip.endFrame),
          visualAdjustments(fitVideoParams(item, target, clip), clip, target))
        : null
      const image = clip.asset.stillImage
        ? newLayer(idGen, clip, clip.sourceIn, videoEnd, boundary(clip.firstFrame), boundary(clip.endFrame),
          visualAdjustments(fitVisualParams(imageOverlayParams(item.id, target) as Extract<Layer['params'], { kind: 'ImageOverlay' }>, item, target, clip), clip, target))
        : null
      const audio = clip.audioRole
        ? newLayer(idGen, clip, audioWindow.sourceIn, audioSourceEnd, audioStart, audioEnd,
          { ...audioParams(item.id, 0, 0), role: clip.audioRole, gain_db: { mode: 'Static', value: clip.volumeDb ?? 0 } })
        : null
      if (video || image) {
        const layer = (video ?? image)!
        track.layers.push(layer)
        visualLayers.set(clip, layer)
        videoClips++
      }
      if (audio) {
        if (clip.splitAudio) splitLayers.push(audio)
        else track.layers.push(audio)
        audioClips++
      }
      if (video && audio) target.links.push({ id: idGen(), members: [video.id, audio.id].sort() })
      for (const mark of clip.markers) {
        const { whole, fraction } = splitExact(mark.source)
        target.markers.push({
          id: idGen(), t_us: boundary(mark.frame), end_t_us: mark.endFrame === null ? null : boundary(mark.endFrame),
          label: mark.label, note: mark.note ?? '', color: DEFAULT_MARKER_COLOR,
          anchor: image || (!video && clip.splitAudio) ? null
            : { layer: (video ?? audio)!.id, src_us: whole, ...(fraction.num ? { src_fraction: fraction } : {}) },
        })
      }
    }
    const audioTracks: Composition['tracks'] = []
    for (const layer of splitLayers.sort((a, b) => a.t_start_us - b.t_start_us)) {
      let track = audioTracks.find(candidate => candidate.layers.at(-1)!.t_end_us <= layer.t_start_us)
      if (!track) {
        if (audioTracks.length >= FCPXML_LIMITS.splitAudioTracks) {
          throw new Error('Too many split audio clips overlap at once. Mix the overlapping audio in the source editor or import the timeline in smaller sections.')
        }
        applyAddTrack(project, idGen, null, audioTracks.length, target.id)
        track = target.tracks[audioTracks.length]!
        audioTracks.push(track)
      }
      track.layers.push(layer)
    }
    for (const dissolve of sequence.dissolves ?? []) {
      target.transitions.push({
        id: idGen(), from_layer: visualLayers.get(dissolve.from)!.id, to_layer: visualLayers.get(dissolve.to)!.id,
        duration_us: boundary(dissolve.endFrame) - boundary(dissolve.firstFrame), kind: { kind: 'Crossfade' }, extended_us: 0,
      })
    }
    for (const group of sequence.groups) {
      let child = built.get(group.timeline)
      if (!child) {
        const { width, height } = group.timeline.canvas!
        child = newComposition(idGen(), idGen, group.timeline.name ?? 'Compound clip', project.next_group_ordinal++, {
          width, height, fps: target.fps, sample_rate: target.sample_rate, channels: target.channels,
          color_space: target.color_space, background: { r: 0, g: 0, b: 0, a: 0 },
        })
        built.set(group.timeline, child)
        project.compositions[child.id] = child
        mapSequence(group.timeline, child)
      }
      const scale = group.conform === 'none' ? 1
        : (group.conform === 'fill' ? Math.max : Math.min)(target.width / child.width, target.height / child.height)
      const transform = defaultTransform(target.width / 2, target.height / 2)
      transform.scale_x = { mode: 'Static', value: scale }
      transform.scale_y = { mode: 'Static', value: scale }
      const params: CompositionRefParams = {
        kind: 'CompositionRef', composition: child.id, src_in_us: 0, src_out_us: 0,
        transform, opacity: { mode: 'Static', value: 1 }, blend_mode: 'Normal',
      }
      writeSourceWindow(params, group.sourceIn, group.sourceOut)
      tracks.get(laneIds.get(0)!)!.layers.push({
        id: idGen(), label: group.label, enabled: group.enabled, locked: false, metadata: {}, effects: [], params,
        t_start_us: boundary(group.firstFrame), t_end_us: boundary(group.endFrame),
      })
    }
    for (const track of target.tracks) track.layers.sort((a, b) => a.t_start_us - b.t_start_us)
    target.markers.sort((a, b) => a.t_us - b.t_us)
    applyDurationAutofit(target)
    if (sequenceEnd > target.duration_us) {
      target.duration_us = sequenceEnd
      target.duration_pinned = true
    }
  }

  mapSequence(timeline, target)
  validate(project)
  async function assertDocumentUnchanged() {
    const currentId = await resolveTimelineInput(path)
      .then(input => readTimelineDocument(input.inputFile, deps)).then(documentId).catch(() => null)
    if (currentId !== reviewedDocumentId) throw new Error('The FCPXML file changed or became unreadable after review. Review the timeline again.')
  }
  return { project, assertDocumentUnchanged, report: {
    name: project.metadata.name, destination, width, height, fps: target.fps, durationFrames: timeline.durationFrames,
    outputColorChange: videoClips ? [...new Set([...sequences].flatMap(sequence => sequence.sourceColor ? [sequence.sourceColor] : []))].join(', ') || null : null,
    compoundGroups: [...sequences].reduce((count, sequence) => count + sequence.groups.filter(group => group.kind === 'compound').length, 0),
    mediaChanges: [...mediaChanges.values()], omittedEffects: [...sequences].flatMap(sequence => sequence.omittedEffects ?? []),
    omittedTitles: [...sequences].flatMap(sequence => sequence.omittedTitles ?? []),
    videoClips, audioClips, markers: Object.values(project.compositions).reduce((count, composition) => count + composition.markers.length, 0), media: Object.keys(project.media_pool).length,
    lanes: allLanes, connectedClips: [...sequences].filter(sequence => !multicamSequences.has(sequence))
      .reduce((count, sequence) => count + sequence.clips.filter(clip => clip.lane !== 0).length, 0), roundedEnds,
    resampledAudioClips, downmixedAudioClips,
    rateConformedVideoClips, resizedVideoClips, videoConversions: [...videoConversions.values()],
    normalizedTimecode: [...sequences].some(sequence => sequence.normalizedTimecode),
    dropFrameTimecode: [...sequences].some(sequence => sequence.dropFrameTimecode),
    namedFormatDefaults: [...sequences].some(sequence => sequence.namedFormatDefaults),
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

function newLayer(idGen: IdGen, clip: TimelineClip, sourceIn: ExactTime, sourceOut: ExactTime, start: number, end: number, params: Extract<Layer['params'], { kind: 'VideoClip' | 'ImageOverlay' }> | AudioParams): Layer {
  // A still image has no moving source clock. Its authored span is on the
  // composition timeline, not a range within a zero-duration image asset.
  if (params.kind !== 'ImageOverlay') {
    writeSourceWindow(params, sourceIn, sourceOut)
    if (clip.playbackRate) params.time_map = affineTimeMap(clip.playbackRate)
    if (params.kind === 'Audio' && clip.preservePitch !== undefined) params.preserve_pitch = clip.preservePitch
  }
  return { id: idGen(), label: clip.label ?? null, t_start_us: start, t_end_us: end,
    enabled: clip.enabled ?? true, locked: false, metadata: {}, params, effects: [] }
}

function validateSource(clip: TimelineClip, item: MediaItem, probe: MediaItem['metadata'] | undefined) {
  const { video, audio, duration_us: duration } = item.metadata
  const fail = (message: string): never => { throw new Error(message) }
  const changes: Pick<TimelineMediaChange, 'kind' | 'detail'>[] = []
  const reportSize = (kind: 'still-size' | 'video-size', declared: { width: number; height: number }) => {
    if (video!.width === declared.width && video!.height === declared.height) return
    changes.push({ kind, detail: 'The timeline lists ' + declared.width + ' × ' + declared.height +
      ' pixels, but this file is ' + video!.width + ' × ' + video!.height +
      '. WeftCut can use the file’s actual size. This may change the framing.' })
  }
  const withEnds = (videoEnd: ExactTime, audioEnd = videoEnd) => ({ videoEnd, audioEnd, changes })
  if (clip.hasVideo && video) {
    const { color_matrix: matrix, color_primaries: primaries, color_transfer: transfer } = video
    const decoded = ffprobeColorToWebCodecs(video)
    if ((primaries != null && decoded?.primaries === undefined) || (transfer != null && decoded?.transfer === undefined) ||
        matrix === 'bt2020nc' || matrix === 'bt2020c' || matrix === 'ictcp') {
      fail('WeftCut cannot reproduce this file’s color settings. It has an unsupported color transfer, gamut or matrix (' +
        [transfer, primaries, matrix].filter(tag => tag != null).join(', ') +
        '). Export an SDR Rec. 709 copy with the same timing, then choose it as the replacement.')
    }
    const declared = clip.asset.sourceColor
    const declared601 = declared === 'Rec. 601 NTSC' || declared === 'Rec. 601 PAL'
    const file601 = [decoded?.matrix, decoded?.primaries, decoded?.transfer]
      .some(tag => tag === 'smpte170m' || tag === 'bt470bg')
    const tagged709 = decoded?.primaries === 'bt709' &&
      (decoded?.transfer === 'bt709' || decoded?.transfer === 'iec61966-2-1') &&
      (matrix == null || decoded.matrix === 'bt709' || decoded.matrix === 'rgb')
    if (declared !== undefined && !declared601) {
      if (!tagged709) fail('The timeline describes this file as ' + declared +
        '. Export an SDR Rec. 709 copy with color tags and the same timing, then choose it as the replacement.')
      changes.push({ kind: 'color-format', detail: 'The timeline describes this file as ' + declared +
        ', but the selected file is tagged SDR Rec. 709. WeftCut can use its SDR colors and keep the cut times.' })
    } else if (declared601 || file601 || (matrix != null && decoded?.matrix === undefined)) {
      const descriptions: string[] = []
      if (declared601) descriptions.push('The timeline describes this file as ' + declared + '.')
      if (file601) descriptions.push('This file uses Rec. 601 color tags.')
      if (matrix != null && decoded?.matrix === undefined) {
        descriptions.push('WeftCut uses its playback default for the unfamiliar color matrix (' + matrix + ').')
      }
      if (decoded?.matrix === undefined || decoded?.primaries === undefined || decoded?.transfer === undefined) {
        descriptions.push('Any missing color tags use WeftCut’s usual playback defaults.')
      }
      descriptions.push('WeftCut will render in SDR Rec. 709. Colors can differ from the source editor. The cut times stay the same.')
      changes.push({ kind: 'color-format', detail: descriptions.join(' ') })
    }
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
    return withEnds(clip.sourceOut)
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
    const differentRate = declared !== undefined && compareTime(probeFrame, declared.frameDuration) !== 0
    if (divideTime(clip.sourceIn, probeFrame).den !== 1) {
      fail(differentRate
        ? 'The file’s frame rate differs from its FCPXML asset format, and this cut starts between its frames. Choose the original or export a replacement at the original rate.'
        : 'The source in-point falls between frames at the probed source frame rate. Choose a source-frame boundary.')
    }
    if (declared) {
      if (differentRate) {
        const declaredRate = divideTime(exactTime(1_000_000), declared.frameDuration)
        changes.push({ kind: 'video-rate', detail: 'The timeline lists ' + declaredRate.num + '/' + declaredRate.den +
          ' fps, but this file is ' + sourceFpsNum + '/' + sourceFpsDen +
          ' fps. WeftCut will keep the cut times. The picture may repeat or skip frames.' })
      }
      reportSize('video-size', declared)
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
  const knownExtent = (extent: unknown): extent is number =>
    typeof extent === 'number' && Number.isSafeInteger(extent) && extent > 0
  let staleDuration = false
  function checkWindow(window: TimelineSourceWindow, stream: 'video' | 'audio', extent: number | null | undefined) {
    const { sourceIn, sourceOut } = window
    const fits = (end: number) => compareTime(sourceIn, exactTime(end)) < 0 && roundTime(sourceOut) <= end
    if (!knownExtent(duration) || !fits(duration)) {
      return fail('The ' + stream + ' trim exceeds the probed duration of the original file. Relink the matching original or shorten the trim.')
    }
    if (knownExtent(extent) && !fits(extent)) {
      return fail('The ' + stream + ' stream ends before this trim. Choose a file with enough ' + stream + ' or shorten the trim.')
    }
    if (compareTime(sourceOut, clip.asset.duration) > 0) {
      if (!knownExtent(extent)) {
        return fail('The trim extends past the length listed in the FCPXML. WeftCut cannot verify that every requested stream covers it. Relink a file with verifiable stream durations or correct the trim in the source editor.')
      }
      staleDuration = true
    }
    const availableEnd = exactTime(knownExtent(extent) ? Math.min(duration, extent) : duration)
    // The probe rounds to microseconds, including at an exclusive fractional frame boundary.
    return compareTime(sourceOut, availableEnd) > 0 ? availableEnd : sourceOut
  }
  const videoEnd = clip.hasVideo ? checkWindow(clip, 'video', probe?.video?.duration_us ?? video?.duration_us) : clip.sourceOut
  const audioEnd = clip.audioRole ? checkWindow(clip.splitAudio ?? clip, 'audio', probe?.audio?.duration_us ?? audio?.duration_us) : clip.sourceOut
  if (staleDuration) {
    const seconds = (clip.asset.duration.num / clip.asset.duration.den / 1_000_000).toFixed(6).replace(/\.?0+$/, '')
    changes.push({ kind: 'source-duration', detail: 'The timeline lists a source length of ' + seconds +
      ' seconds, but a cut uses later material. The file contains that material. WeftCut can keep the original cut times.' })
  }
  return withEnds(videoEnd, audioEnd)
}
