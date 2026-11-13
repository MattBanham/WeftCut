import { SaxesParser } from 'saxes'
import { canvasSizeError, FPS_OPTIONS } from '../../../shared/newProject'
import type { ExactTime } from '../../../shared/timeMapping'
import { TimeMappingError } from '../../../shared/timeMapping'
import { addTime, ceilTime, compareTime, divideTime, exactTime, floorTime, multiplyTime, roundTime, subtractTime, ZERO_TIME } from '../../../renderer/timeMapping'
import type { TimelineCompatibilityItem } from '../../../shared/timelineImport'
import type { ImportTimeline, TimelineClip, TimelineSource } from './timeline'
import { originalMediaPath, type OriginalMediaPath } from './mediaPath'

interface Element {
  tag: string
  attrs: Record<string, string>
  children: Element[]
  line: number
}

interface Asset extends TimelineSource {
  start: ExactTime
  duration: ExactTime
  hasAudio: boolean
  mediaNotices: string[]
}

interface Format {
  width: number
  height: number
  frameDuration: ExactTime
  paspH: number
  paspV: number
  namedDefaults: boolean
  sourceColor?: string
}

export const FCPXML_LIMITS = {
  bytes: 16 * 1024 * 1024,
  depth: 24,
  elements: 50_000,
  mediaFiles: 2_048,
  directoryEntries: 50_000,
  attributes: 64,
  attributeLength: 16_384,
} as const

const US_PER_SECOND = { num: 1_000_000, den: 1 }

function location(el: Element): string {
  const name = el.attrs.name || el.attrs.id
  return `<${el.tag}> at line ${el.line}${name ? ` (${name})` : ''}`
}

function fail(el: Element, message: string): never {
  throw new Error(`FCPXML ${location(el)}: ${message}`)
}

function readXml(xml: string): Element {
  if (Buffer.byteLength(xml, 'utf8') > FCPXML_LIMITS.bytes) {
    throw new Error('FCPXML exceeds the 16 MiB document limit. Export a smaller sequence')
  }
  if (/[\uD800-\uDFFF]/u.test(xml)) throw new Error('Malformed FCPXML: invalid Unicode surrogate')
  let elements = 0
  const document: Element = { tag: 'document', attrs: {}, children: [], line: 1 }
  const stack = [document]
  const parser = new SaxesParser<{ xmlns: false }>({ xmlns: false })
  parser.on('error', (error) => { throw new Error(`Malformed FCPXML at ${error.message}`) })
  parser.on('xmldecl', ({ encoding }) => {
    if (encoding && !/^utf-8$/i.test(encoding)) throw new Error('Export the FCPXML document as UTF-8 and try again')
  })
  parser.on('doctype', (value) => {
    if (value.trim() !== 'fcpxml') throw new Error('FCPXML supports only the plain <!DOCTYPE fcpxml> declaration')
  })
  parser.on('opentagstart', (tag) => {
    if (stack.length > FCPXML_LIMITS.depth) throw new Error(`FCPXML nesting is too deep at line ${parser.line}`)
    if (++elements > FCPXML_LIMITS.elements) throw new Error('FCPXML contains too many elements. Export a smaller sequence')
    const el: Element = { tag: tag.name, attrs: {}, children: [], line: parser.line }
    stack[stack.length - 1]!.children.push(el)
    stack.push(el)
  })
  parser.on('opentag', (tag) => {
    const attrs = Object.entries(tag.attributes)
    if (attrs.length > FCPXML_LIMITS.attributes || attrs.some(([key, value]) =>
      key.length > FCPXML_LIMITS.attributeLength || value.length > FCPXML_LIMITS.attributeLength)) {
      throw new Error('FCPXML attribute limits exceeded. Shorten metadata or export a smaller sequence')
    }
    stack[stack.length - 1]!.attrs = tag.attributes
  })
  parser.on('closetag', () => { stack.pop() })
  function text(value: string) {
    const el = stack[stack.length - 1]!
    const inMetadata = el.tag === 'string' && stack.at(-2)?.tag === 'array' &&
      stack.at(-3)?.tag === 'md' && stack.at(-4)?.tag === 'metadata' && stack.at(-5)?.tag === 'asset'
    // Title text is interpreted only by the title importer. Keep reading here
    // so an unsupported title can give a remedy instead of an XML error.
    const inTitle = ['text', 'text-style'].includes(el.tag) && stack.some(node => node.tag === 'title')
    if (value.trim() && !inMetadata && !inTitle) fail(el, 'Unexpected text')
  }
  parser.on('text', text)
  parser.on('cdata', text)
  parser.write(xml).close()
  const root = document.children[0]
  if (!root || root.tag !== 'fcpxml') throw new Error('Choose a .fcpxml document with an <fcpxml> root')
  return root
}

function check(el: Element, attrs: readonly string[], children: readonly string[] = []) {
  const errors: string[] = []
  for (const name of Object.keys(el.attrs)) {
    if (!attrs.includes(name)) errors.push('FCPXML ' + location(el) + ': Unsupported attribute "' + name + '". Remove it or simplify the edit and export again')
  }
  for (const child of el.children) {
    if (!children.includes(child.tag)) errors.push('FCPXML ' + location(child) + ': Unsupported inside <' + el.tag + '>. Simplify the edit and export again')
  }
  if (errors.length) throw new Error(errors.join('\n'))
}

function one(el: Element, tag: string): Element {
  const matches = el.children.filter((child) => child.tag === tag)
  if (matches.length !== 1) fail(el, `Expected exactly one <${tag}>, found ${matches.length}`)
  return matches[0]!
}

function required(el: Element, key: string): string {
  const value = el.attrs[key]
  if (!value?.trim()) fail(el, `Missing "${key}"`)
  return value
}

function time(el: Element, key: string, fallback?: ExactTime): ExactTime {
  if (el.attrs[key] === undefined && fallback !== undefined) return fallback
  const raw = required(el, key)
  const match = /^(\d{1,16})(?:\/(\d{1,10}))?s$/.exec(raw)
  if (!match) fail(el, `"${key}" must be a non-negative rational time in seconds, for example 1001/30000s`)
  try { return multiplyTime(exactTime(Number(match[1]), Number(match[2] ?? 1)), US_PER_SECOND) }
  catch (error) {
    if (error instanceof TimeMappingError) fail(el, `"${key}" has an invalid or out-of-range time: ${raw}`)
    throw error
  }
}

function frames(value: ExactTime, format: Format, el: Element, key: string): number {
  const index = divideTime(value, format.frameDuration)
  if (index.den !== 1) fail(el, `"${key}" is between frames. Align it to the video frame grid and export again`)
  return index.num
}

function integer(el: Element, key: string): number {
  const raw = required(el, key)
  const number = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number)) fail(el, `"${key}" must be a whole number`)
  return number
}

function audioSampleRate(el: Element, key: string, zeroAllowed = false): number {
  const raw = required(el, key)
  // FCPXML sequence settings commonly use "44.1k" / "48k", whereas
  // source asset metadata may use integer Hz. Both describe source metadata,
  // not the 48 kHz lattice used internally by WeftCut's audio conformer.
  const match = /^(\d+)(?:\.(\d+))?k$/.exec(raw)
  const rate = match ? Number(raw.slice(0, -1)) * 1000 : Number(raw)
  if (!Number.isSafeInteger(rate) || rate < 0 || (!zeroAllowed && rate === 0) || rate > 384_000 ||
      (!match && !/^\d+$/.test(raw))) {
    fail(el, `Invalid audio sample rate "${raw}"`)
  }
  return rate
}

// Apple's predefined FFVideoFormat names carry the fields omitted from a
// <format>. Only progressive square-pixel presets with a known WeftCut rate
// are decoded here; guessing other names would silently change an edit.
function predefinedFormat(name: string | undefined): Omit<Format, 'namedDefaults'> | null {
  const match = /^FFVideoFormat(?:(1080|720)|(\d{3,5})x(\d{3,5}))p(2398|24|25|2997|30|50|5994|60)$/.exec(name ?? '')
  if (!match) return null
  const width = match[1] === '1080' ? 1920 : match[1] === '720' ? 1280 : Number(match[2])
  const height = match[1] ? Number(match[1]) : Number(match[3])
  const rate = match[4]!
  const fps = rate === '2398' ? { num: 24_000, den: 1001 }
    : rate === '2997' ? { num: 30_000, den: 1001 }
      : rate === '5994' ? { num: 60_000, den: 1001 }
        : { num: Number(rate), den: 1 }
  return { width, height, frameDuration: exactTime(1_000_000 * fps.den, fps.num),
    paspH: 1, paspV: 1 }
}

function colorName(value: string | undefined): string | undefined {
  const code = value?.trim().split(/\s+/)[0]
  if (code === undefined || code === '1-1-1') return undefined
  switch (code) {
    case '9-16-9': return 'HDR (Rec. 2020 PQ)'
    case '9-18-9': return 'HDR (Rec. 2020 HLG)'
    case '9-1-9': return 'wide-gamut Rec. 2020'
    case '6-1-6': return 'Rec. 601 NTSC'
    case '5-1-6': return 'Rec. 601 PAL'
    default: return value
  }
}

function parseFormat(el: Element, sourceFormat = false): Format {
  check(el, ['id', 'name', 'frameDuration', 'width', 'height', 'colorSpace', 'fieldOrder', 'paspH', 'paspV'])
  const a = el.attrs
  if (a.fieldOrder !== undefined && a.fieldOrder !== 'progressive') {
    fail(el, 'This format is interlaced. Export a progressive copy at the same frame rate to keep the cuts in place.')
  }
  const sourceColor = colorName(a.colorSpace)
  const paspH = a.paspH === undefined ? 1 : integer(el, 'paspH')
  const paspV = a.paspV === undefined ? 1 : integer(el, 'paspV')
  if (paspH < 1 || paspV < 1 || paspH > 65_535 || paspV > 65_535) {
    fail(el, 'Pixel aspect ratio values must be between 1 and 65535')
  }
  if (!sourceFormat && paspH !== paspV) {
    fail(el, 'Non-square sequence pixel aspect ratios require a separate project-canvas conversion')
  }
  const preset = predefinedFormat(a.name)
  const namedDefaults = a.width === undefined || a.height === undefined || a.frameDuration === undefined
  if (namedDefaults && !preset) {
    fail(el, 'Format needs width, height and frameDuration, or a supported predefined progressive FFVideoFormat name. Do not guess missing settings')
  }
  const width = a.width === undefined ? preset!.width : integer(el, 'width')
  const height = a.height === undefined ? preset!.height : integer(el, 'height')
  if (sourceFormat ? width < 1 || height < 1 : canvasSizeError(width, height)) {
    fail(el, sourceFormat ? 'The source dimensions must be positive'
      : 'The sequence canvas must use even dimensions within WeftCut’s supported range. Export the timeline at a supported canvas size.')
  }
  const frameDuration = a.frameDuration === undefined ? preset!.frameDuration : time(el, 'frameDuration')
  if (frameDuration.num <= 0) fail(el, 'Video frameDuration must be positive')
  return { width, height, frameDuration, paspH, paspV, namedDefaults, sourceColor }
}

function localPath(el: Element): OriginalMediaPath {
  try { return originalMediaPath(required(el, 'src')) }
  catch (error) { return fail(el, error instanceof Error ? error.message : String(error)) }
}

function parseAsset(el: Element, lookup: (ref: string, tag: string, from: Element) => Element): Asset {
  check(el, ['id', 'name', 'uid', 'src', 'start', 'duration', 'hasVideo', 'hasAudio', 'format',
    'audioSources', 'audioChannels', 'audioRate', 'videoSources', 'colorSpaceOverride'], ['media-rep', 'metadata'])
  const a = el.attrs
  if (a.hasVideo !== undefined && a.hasVideo !== '0' && a.hasVideo !== '1') fail(el, 'Invalid "hasVideo" flag')
  const hasVideo = a.hasVideo === '1'
  if (a.videoSources !== undefined && a.videoSources !== (hasVideo ? '1' : '0'))
    fail(el, 'Only a single video stream per asset is supported')
  if (a.hasAudio !== undefined && a.hasAudio !== '0' && a.hasAudio !== '1') fail(el, 'Invalid "hasAudio" flag')
  const hasAudio = a.hasAudio === '1'
  if (!hasVideo && !hasAudio) fail(el, 'The asset must declare video or audio')
  if (a.audioSources !== undefined && a.audioSources !== (hasAudio ? '1' : '0'))
    fail(el, 'Only one embedded audio stream per asset is supported')
  const audioChannels = a.audioChannels === undefined ? undefined : integer(el, 'audioChannels')
  const audioRate = a.audioRate === undefined ? undefined : audioSampleRate(el, 'audioRate', !hasAudio)
  if ((audioChannels !== undefined && (hasAudio ? (audioChannels < 1 || audioChannels > 8) : audioChannels !== 0)) ||
      (audioRate !== undefined && (hasAudio ? audioRate === 0 : audioRate !== 0))) {
    fail(el, 'Use an asset with at most one audio stream and 1–8 channels')
  }
  const duration = time(el, 'duration')
  // Still-image assets in FCPXML describe zero source duration: the enclosing
  // <video> gives the duration on the edit. Do not impose video-frame/source
  // duration checks on still artwork.
  const stillImage = hasVideo && !hasAudio && duration.num === 0
  let videoFormat: Asset['videoFormat']
  let imageSize: Asset['imageSize']
  let sourceColor: string | undefined
  if (a.format !== undefined) {
    if (!hasVideo) fail(el, 'Audio-only assets must not refer to a video format')
    const formatNode = lookup(a.format, 'format', el)
    if (stillImage) {
      check(formatNode, ['id', 'name', 'frameDuration', 'width', 'height', 'colorSpace', 'fieldOrder', 'paspH', 'paspV'])
      imageSize = { width: integer(formatNode, 'width'), height: integer(formatNode, 'height') }
      if (!imageSize.width || !imageSize.height) fail(formatNode, 'Still-image dimensions must be positive')
      sourceColor = colorName(formatNode.attrs.colorSpace)
      if ((formatNode.attrs.fieldOrder !== undefined && formatNode.attrs.fieldOrder !== 'progressive') ||
          Number(formatNode.attrs.paspH ?? 1) !== 1 || Number(formatNode.attrs.paspV ?? 1) !== 1) {
        fail(formatNode, 'This still format needs square pixels and progressive scan. Export a square-pixel copy in the source editor.')
      }
    } else {
      const source = parseFormat(formatNode, true)
      sourceColor = source.sourceColor
      videoFormat = { width: source.width, height: source.height, frameDuration: source.frameDuration,
        paspH: source.paspH, paspV: source.paspV }
    }
  }
  const representations = el.children.filter(child => child.tag === 'media-rep')
  const metadata = el.children.filter(child => child.tag === 'metadata')
  if (metadata.length > 1) fail(el, 'An asset can have only one metadata section')
  for (const group of metadata) {
    check(group, [], ['md'])
    for (const entry of group.children) {
      check(entry, ['key', 'value', 'type', 'editable', 'displayName', 'source', 'description'], ['array'])
      for (const array of entry.children) {
        check(array, [], ['string'])
        for (const item of array.children) check(item, [])
      }
    }
  }
  if (a.colorSpaceOverride !== undefined) {
    if (!hasVideo) fail(el, 'Only visual media can have a color-space override')
    sourceColor = colorName(a.colorSpaceOverride)
  }
  const mediaNotices: string[] = []
  if (metadata.length) mediaNotices.push('Custom asset metadata is not copied to the project')
  const originalReps: Element[] = []
  for (const rep of representations) {
    check(rep, ['kind', 'src', 'sig'])
    const kind = rep.attrs.kind ?? 'original-media'
    if (kind === 'original-media') originalReps.push(rep)
    else if (kind !== 'proxy-media') fail(rep, 'This media representation is unsupported. Export a reference to the original file.')
  }
  if (a.src !== undefined && representations.length) fail(el, 'The asset specifies both a legacy URL and media representations. Export it with one original.')
  if (a.src === undefined && originalReps.length !== 1) {
    fail(el, 'The asset needs exactly one original media-rep. Relink the original in the source editor and export again.')
  }
  if (representations.length > originalReps.length) mediaNotices.push('Proxy media in the FCPXML is not used. WeftCut imports the original file.')
  if (representations.some(rep => rep.attrs.sig !== undefined)) mediaNotices.push('Source media signature is not retained')
  const original = localPath(a.src !== undefined ? el : originalReps[0]!)

  if (duration.num === 0 && !stillImage) fail(el, 'Asset duration must be positive')
  return { ref: required(el, 'id'), ...original, start: time(el, 'start', ZERO_TIME), duration,
    hasVideo, hasAudio, stillImage, imageSize, sourceColor, videoFormat, audioChannels, audioRate, mediaNotices }
}

export interface FcpxmlSequenceChoice {
  index: number
  name: string
  event: string | null
  location: string
}

function collectProjects(root: Element): { project: Element; event: string | null }[] {
  check(root, ['version'], ['resources', 'import-options', 'project', 'library', 'event'])
  if (!/^1\.(?:[6-9]|1[0-3])$/.test(required(root, 'version'))) {
    fail(root, 'Use an FCPXML document version 1.6 through 1.13')
  }
  one(root, 'resources')
  const importOptions = root.children.filter(child => child.tag === 'import-options')
  if (importOptions.length > 1) fail(root, 'More than one <import-options> element')
  for (const optionSet of importOptions) {
    check(optionSet, [], ['option'])
    for (const option of optionSet.children) check(option, ['key', 'value'])
  }
  const projects: { project: Element; event: string | null }[] = []
  function fromEvent(event: Element) {
    check(event, ['name', 'uid'], ['project', 'collection-folder', 'keyword-collection', 'smart-collection',
      'clip', 'audition', 'mc-clip', 'ref-clip', 'sync-clip', 'asset-clip'])
    for (const project of event.children.filter(child => child.tag === 'project')) {
      projects.push({ project, event: event.attrs.name ?? null })
    }
  }
  for (const entry of root.children) {
    if (entry.tag === 'project') projects.push({ project: entry, event: null })
    else if (entry.tag === 'event') fromEvent(entry)
    else if (entry.tag === 'library') {
      check(entry, ['location'], ['event'])
      for (const event of entry.children) fromEvent(event)
    }
  }
  if (projects.length === 0) fail(root, 'No project with a sequence was found')
  return projects
}

export function listFcpxmlSequences(xml: string): FcpxmlSequenceChoice[] {
  return collectProjects(readXml(xml)).map(({ project, event }, index) => ({
    index, name: project.attrs.name || `Untitled sequence ${index + 1}`,
    event, location: location(project),
  }))
}

export class TimelineEditFailure extends Error {
  constructor(readonly issues: TimelineCompatibilityItem[], readonly canOmitEffects: boolean) {
    super(issues.flatMap(issue => issue.notes).join('\n'))
  }
}

export function parseFcpxml(xml: string, sequenceIndex?: number, omitEffects = false): ImportTimeline {
  try { return parseDocument(readXml(xml), sequenceIndex, omitEffects) }
  catch (error) {
    if (error instanceof TimeMappingError) throw new Error(`FCPXML timing is outside the supported range (${error.code})`)
    throw error
  }
}

function parseDocument(root: Element, sequenceIndex: number | undefined, omitEffects: boolean): ImportTimeline {
  const choices = collectProjects(root)
  if (sequenceIndex === undefined && choices.length > 1) {
    fail(root, `Found ${choices.length} project sequences. Choose which one to import`)
  }
  const index = sequenceIndex ?? 0
  if (!Number.isSafeInteger(index) || index < 0 || index >= choices.length) {
    fail(root, `Sequence index ${String(index)} is not available. Choose a listed sequence`)
  }
  const resources = one(root, 'resources')
  const project = choices[index]!.project
  check(project, ['name', 'uid', 'modDate'], ['sequence'])
  const seq = one(project, 'sequence')
  check(seq, ['format', 'tcStart', 'tcFormat', 'duration', 'audioLayout', 'audioRate'], ['spine'])
  const effectUids = new Map(resources.children.filter(child => child.tag === 'effect').map(child => [child.attrs.id, child.attrs.uid]))
  const crossDissolveUid = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265'
  function dissolveFilter(el: Element): Element | undefined {
    const filter = el.children[0]
    return el.children.length === 1 && filter?.tag === 'filter-video' && !filter.children.length &&
      effectUids.get(filter.attrs.ref) === crossDissolveUid ? filter : undefined
  }
  const unsupported: TimelineCompatibilityItem[] = []
  const omittedEffects: TimelineCompatibilityItem[] = []
  let canOmitEffects = true
  const supportedStory = new Set(['spine', 'gap', 'asset-clip', 'video', 'audio', 'marker',
    'adjust-conform', 'adjust-volume', 'adjust-transform', 'adjust-blend', 'timeMap', 'timept'])
  const remedies: Record<string, string> = {
    transition: 'WeftCut cannot recreate this transition. Render the adjoining clips with the transition, or replace it with a cut before exporting.',
    title: 'WeftCut cannot recreate this title. Render it into a clip, or export it as an overlay with transparency and replace the title.',
    'mc-clip': 'Choose the camera angles you want to keep, then flatten the multicam edit to ordinary clips before exporting.',
    'ref-clip': 'Open this compound clip in the source editor and put its contents directly on the timeline, or render it as one clip.',
    timeMap: 'WeftCut cannot recreate this speed change. Render the retimed clip, then replace it in the source edit before exporting.',
    'filter-video': 'WeftCut cannot recreate this effect. Render the clip with the effect applied or remove the effect before exporting.',
    param: 'WeftCut cannot recreate these effect parameters. Render the effect or replace it with a supported static adjustment.',
  }
  function scanStory(parent: Element) {
    const kept: Element[] = []
    for (const child of parent.children) {
      // Nonlinear, reverse and incomplete maps get the ordinary retime remedy.
      // The affine subset is validated against the clip window below.
      const candidateMap = child.tag !== 'timeMap' ||
        (['asset-clip', 'video', 'audio'].includes(parent.tag) && child.children.length === 2 &&
          child.children.every(point => point.tag === 'timept' && point.attrs.interp === 'linear'))
      if (child.tag === 'transition' && parent.tag === 'spine' && dissolveFilter(child)) {
        kept.push(child)
        continue
      }
      if (!candidateMap || !supportedStory.has(child.tag)) {
        const remedy = Object.hasOwn(remedies, child.tag) ? remedies[child.tag]
          : 'Simplify or render this part in the source editor before exporting.'
        const parameterTree = (node: Element): boolean =>
          ['param', 'keyframeAnimation', 'keyframe', 'data'].includes(node.tag) && node.children.every(parameterTree)
        const safeToOmit = ['asset-clip', 'video', 'audio'].includes(parent.tag) &&
          ['filter-video', 'filter-audio'].includes(child.tag) && child.children.every(parameterTree)
        const info = { location: location(child), label: child.attrs.name || child.tag,
          lane: Number(parent.attrs.lane ?? 0) || 0 }
        if (omitEffects && safeToOmit) {
          omittedEffects.push({ ...info, status: 'approximated',
            notes: ['This effect will be left out. The clip and its cut times will be kept.'] })
          continue
        }
        canOmitEffects &&= safeToOmit
        unsupported.push({ ...info, status: 'unsupported',
          notes: ['FCPXML ' + location(child) + ': Unsupported inside <' + parent.tag + '>. ' + remedy] })
      } else scanStory(child)
      kept.push(child)
    }
    parent.children = kept
  }
  scanStory(seq)
  if (unsupported.length) throw new TimelineEditFailure(unsupported, canOmitEffects)
  const notices: TimelineCompatibilityItem[] = [...omittedEffects]
  const notice = (el: Element, note: string) => notices.push({ location: location(el),
    label: el.attrs.name || el.tag, lane: 0, status: 'converted', notes: [note] })
  if (choices.length > 1) notice(project, 'Only the selected sequence is imported; other sequences remain in the source document')
  if (root.children.some(el => el.tag === 'library' || el.tag === 'event') ||
      project.attrs.uid || project.attrs.modDate) {
    notice(project, 'Only the selected edit is imported. Library and event organization, standalone clips, collections and source metadata are not copied')
  }
  for (const options of root.children.filter(el => el.tag === 'import-options')) {
    for (const option of options.children) notice(option, 'Source-editor import option is not applied: ' + (option.attrs.key ?? '(unnamed)') + ' = ' + (option.attrs.value ?? ''))
  }
  if (seq.attrs.audioLayout || seq.attrs.audioRate) notice(seq,
    'Sequence audio output settings (' + (seq.attrs.audioLayout ?? 'default layout') + ', ' +
    (seq.attrs.audioRate ?? 'default rate') + ') use the destination project output settings; editing uses 48 kHz samples')
  const tcFormat = seq.attrs.tcFormat ?? 'NDF'
  if (tcFormat !== 'NDF' && tcFormat !== 'DF') fail(seq, 'Sequence tcFormat must be NDF or DF')
  const sequenceOrigin = time(seq, 'tcStart', ZERO_TIME)
  const audioLayout = seq.attrs.audioLayout ?? 'stereo'
  if (!['mono', 'stereo', 'surround'].includes(audioLayout))
    fail(seq, `Unsupported sequence audio layout "${audioLayout}"`)
  // Sequence audio is presentation metadata; source media can use other sample
  // rates and channel layouts, which the existing conform pipeline converts.
  if (seq.attrs.audioRate !== undefined) audioSampleRate(seq, 'audioRate')

  const byId = new Map<string, Element>()
  for (const el of resources.children) {
    const id = required(el, 'id')
    if (byId.has(id)) fail(el, `Duplicate resource ID "${id}"`)
    byId.set(id, el)
  }
  const lookup = (ref: string, tag: string, from: Element): Element => {
    const item = byId.get(ref)
    if (item?.tag !== tag) fail(from, `Resource "${ref}" must refer to a <${tag}>`)
    return item
  }
  const format = parseFormat(lookup(required(seq, 'format'), 'format', seq))
  const fps = FPS_OPTIONS.find(({ num, den }) =>
    compareTime(format.frameDuration, exactTime(1_000_000 * den, num)) === 0)
  if (!fps) fail(seq, 'Choose a supported WeftCut timeline frame rate')
  if (tcFormat === 'DF' && !(fps.den === 1001 && [30_000, 60_000].includes(fps.num))) {
    fail(seq, 'Drop-frame display timecode requires 30000/1001 or 60000/1001 fps')
  }
  const spine = one(seq, 'spine')
  check(spine, [], ['gap', 'asset-clip', 'video', 'audio', 'transition'])
  const clips: TimelineClip[] = []
  const assets = new Map<string, Asset>()
  const dissolves: NonNullable<ImportTimeline['dissolves']> = []
  let pendingDissolve: { el: Element; from: TimelineClip; start: ExactTime; end: ExactTime } | undefined
  let primaryEnd = ZERO_TIME
  let lastEnd = ZERO_TIME
  const connected: { element: Element; clip: TimelineClip }[] = []

  function readClip(el: Element, parent?: { offset: ExactTime; start: ExactTime }) {
    const a = el.attrs
    const gap = el.tag === 'gap'
    check(el, gap
      ? ['name', 'lane', 'offset', 'start', 'duration']
      : ['name', 'lane', 'offset', 'start', 'duration', 'ref', 'enabled', 'audioRole', 'videoRole', 'format', 'tcFormat', 'srcEnable', 'role'],
    parent ? ['marker', 'adjust-conform', 'adjust-volume', 'adjust-transform', 'adjust-blend', 'timeMap']
      : gap ? ['asset-clip', 'video', 'audio']
        : ['marker', 'asset-clip', 'video', 'audio', 'adjust-conform', 'adjust-volume', 'adjust-transform', 'adjust-blend', 'timeMap'])
    const lane = Number(a.lane ?? '0')
    if (parent) {
      if (!/^-?[1-9]\d*$/.test(a.lane ?? '') || !Number.isSafeInteger(lane))
        fail(el, 'A connected clip needs a nonzero integer lane')
    } else if ((a.lane ?? '0') !== '0') {
      fail(el, 'Connected clips must be nested inside their primary clip or gap')
    }
    const localOffset = parent ? time(el, 'offset') : time(el, 'offset', sequenceOrigin)
    const offset = parent
      ? addTime(parent.offset, subtractTime(localOffset, parent.start))
      : subtractTime(localOffset, sequenceOrigin)
    if (offset.num < 0) fail(el, 'The clip starts before the timeline origin')
    const notes: string[] = []
    if (parent) notes.push('Connected anchor relationship is replaced by independent placement; moving the former anchor will not move this clip')
    if (a.tcFormat === 'DF') notes.push('Clip drop-frame display metadata becomes zero-based non-drop-frame timecode')
    if (!['0', '1'].includes(a.enabled ?? '1') || (a.tcFormat !== undefined && a.tcFormat !== 'NDF' && a.tcFormat !== 'DF') ||
        (a.videoRole ?? 'video') !== 'video') {
      fail(el, 'The clip has an invalid enabled flag or timecode, or a custom video role')
    }
    const ref = gap ? undefined : required(el, 'ref')
    const assetNode = ref === undefined ? undefined : lookup(ref, 'asset', el)
    let asset = ref === undefined ? undefined : assets.get(ref)
    if (assetNode && ref !== undefined && !asset) {
      asset = parseAsset(assetNode, lookup)
      assets.set(ref, asset)
      if (assetNode.attrs.colorSpaceOverride !== undefined && asset.sourceColor === undefined) {
        notice(assetNode, 'The Rec. 709 color override is not copied. WeftCut checks the colors declared by the actual file.')
      }
      if (assetNode.attrs.uid !== undefined) notice(assetNode, 'Source asset UID is not retained')
      for (const detail of asset.mediaNotices) notice(assetNode, detail)
    }
    const component = el.tag === 'video' || el.tag === 'audio' ? el.tag : a.srcEnable ?? 'all'
    if (!['all', 'video', 'audio'].includes(component) || (el.tag !== 'asset-clip' && a.srcEnable !== undefined)) {
      fail(el, 'Choose all media, audio only, or video only on an asset clip')
    }
    const hasVideo = asset?.hasVideo === true && component !== 'audio'
    const hasAudio = asset?.hasAudio === true && component !== 'video'
    if (asset && !hasVideo && !hasAudio) fail(el, 'The file does not declare the video or audio this clip requests')
    const duration = time(el, 'duration', el.tag === 'asset-clip' ? asset?.duration : undefined)
    if (duration.num <= 0) fail(el, 'The clip needs a positive duration')
    const end = addTime(offset, duration)
    const audioOnly = asset !== undefined && !hasVideo
    const firstFrame = audioOnly ? floorTime(divideTime(offset, format.frameDuration)) : frames(offset, format, el, 'offset')
    const endFrame = audioOnly ? ceilTime(divideTime(end, format.frameDuration)) : frames(end, format, el, 'end')
    if (!audioOnly && endFrame <= firstFrame) fail(el, 'Duration must span at least one video frame')
    if (!parent) {
      if (compareTime(offset, primaryEnd) < 0 && !pendingDissolve) {
        fail(el, 'Overlaps the preceding item. Remove the overlap or transition and export again')
      }
      primaryEnd = end
    }
    if (compareTime(end, lastEnd) > 0) lastEnd = end
    const start = time(el, 'start', asset?.start ?? ZERO_TIME)
    for (const child of el.children) {
      if (['asset-clip', 'video', 'audio'].includes(child.tag)) readClip(child, { offset, start })
    }
    if (!asset || !assetNode) {
      if (a.name) notice(el, 'Named gap is represented as empty timeline space; its label is not retained')
      return
    }
    if ((lane < 0 && hasVideo) || (lane > 0 && !hasVideo))
      fail(el, 'Place connected video in positive lanes and connected audio-only clips in negative lanes')
    if (a.format !== undefined && a.format !== assetNode.attrs.format && a.format !== seq.attrs.format) {
      const candidate = lookup(a.format, 'format', el)
      if (asset.stillImage) {
        // Still formats can omit the video rate. Equivalent declarations must
        // also agree on color, field order and pixel shape.
        const assetFormat = assetNode.attrs.format
        const original = assetFormat === undefined ? null : lookup(assetFormat, 'format', el)
        const keys = ['name', 'width', 'height', 'frameDuration', 'colorSpace', 'fieldOrder', 'paspH', 'paspV']
        check(candidate, ['id', ...keys])
        if (!original || !keys.every(key => candidate.attrs[key] === original.attrs[key])) {
          fail(el, 'The still has a different clip format. Export the clip with the same image format as its source.')
        }
      } else {
        const other = parseFormat(candidate, true)
        const same = (known: Pick<Format, 'width' | 'height' | 'frameDuration' | 'paspH' | 'paspV'>) =>
          known.width === other.width && known.height === other.height &&
          compareTime(known.frameDuration, other.frameDuration) === 0 &&
          known.paspH * other.paspV === known.paspV * other.paspH
        if (other.sourceColor !== undefined && other.sourceColor !== format.sourceColor && other.sourceColor !== asset.sourceColor) {
          fail(el, 'The clip adds a color format that differs from both the source and sequence. Export it as an SDR Rec. 709 clip.')
        }
        if (!same(format) && (!asset.videoFormat || !same(asset.videoFormat))) {
          fail(el, 'The clip format differs from its source and timeline. Export the clip with a matching format.')
        }
      }
    }
    const conformance = el.children.filter(child => child.tag === 'adjust-conform')
    if (conformance.length > 1) fail(el, 'Only one spatial conform operation is supported')
    let conform: 'fit' | 'fill' | 'none' = 'fit'
    if (conformance.length) {
      const operation = conformance[0]!
      check(operation, ['type'])
      conform = (operation.attrs.type ?? 'fit') as typeof conform
      if (!['fit', 'fill', 'none'].includes(conform)) fail(operation, 'Spatial conform must be fit, fill or none')
      if (!hasVideo) fail(operation, 'Spatial conform requires a video or image clip')
    }
    const volumeOps = el.children.filter(child => child.tag === 'adjust-volume')
    if (volumeOps.length > 1) fail(el, 'Only one static volume operation is supported')
    let volumeDb = 0
    if (volumeOps.length) {
      const operation = volumeOps[0]!
      check(operation, ['amount'])
      if (!hasAudio) fail(operation, 'Volume adjustment requires source audio')
      const raw = operation.attrs.amount ?? '0dB'
      if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)dB$/.test(raw)) {
        fail(operation, 'Only static dB volume adjustments are supported; keyframed, relative and infinite gain require an audio conversion')
      }
      volumeDb = Number(raw.slice(0, -2))
      if (!Number.isFinite(volumeDb) || volumeDb < -30 || volumeDb > 20) {
        fail(operation, 'Volume gain must be between -30dB and +20dB, within WeftCut editable range')
      }
    }
    const transformOps = el.children.filter(child => child.tag === 'adjust-transform')
    const blendOps = el.children.filter(child => child.tag === 'adjust-blend')
    if (transformOps.length > 1 || blendOps.length > 1) {
      fail(el, 'Only one static transform and one static blend operation per clip are supported')
    }
    if (!hasVideo && (transformOps.length || blendOps.length)) {
      fail(el, 'Visual adjustments require a video or image clip')
    }
    let staticTransform: TimelineClip['staticTransform']
    if (transformOps.length) {
      const operation = transformOps[0]!
      check(operation, ['enabled', 'position', 'scale', 'rotation', 'anchor'])
      if (operation.attrs.enabled !== undefined && !['0', '1'].includes(operation.attrs.enabled)) {
        fail(operation, 'Invalid transform enabled flag')
      }
      function pair(value: string, attribute: string): [number, number] {
        const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(value)
        if (!match) fail(operation, 'Static transform ' + attribute + ' needs two finite numbers')
        const x = Number(match[1]), y = Number(match[2])
        if (![x, y].every(Number.isFinite)) fail(operation, 'Invalid static transform vector')
        return [x, y]
      }
      const anchor = pair(operation.attrs.anchor ?? '0 0', 'anchor')
      if (anchor[0] !== 0 || anchor[1] !== 0) {
        fail(operation, 'Nonzero anchor offsets require a verified pivot conversion')
      }
      if (operation.attrs.enabled === '0') notes.push('Disabled transform and its stored parameter values are not retained')
      if (operation.attrs.enabled !== '0') {
        const pos = pair(operation.attrs.position ?? '0 0', 'position')
        const scale = pair(operation.attrs.scale ?? '1 1', 'scale')
        const rotation = Number(operation.attrs.rotation ?? '0')
        if (scale.some(n => n <= 0 || n > 10) || !Number.isFinite(rotation) ||
            Math.abs(rotation) > 360 || pos.some(n => Math.abs(n) > 1000)) {
          fail(operation, 'Static transform must have positive 0–10 scales, ±360° rotation and ±1000% positions')
        }
        staticTransform = { xPercent: pos[0], yPercent: pos[1],
          scaleX: scale[0], scaleY: scale[1], rotation }
      }
    }
    let opacity: number | undefined
    if (blendOps.length) {
      const operation = blendOps[0]!
      check(operation, ['amount', 'mode'])
      if (!['0', 'normal'].includes(operation.attrs.mode ?? '0')) {
        fail(operation, 'Only normal blend mode can be imported without a verified compositor mapping')
      }
      const raw = operation.attrs.amount ?? '1'
      if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(raw)) {
        fail(operation, 'Static opacity must be between 0 and 1')
      }
      opacity = Number(raw)
    }
    if (a.role !== undefined && el.tag !== 'audio' && (el.tag !== 'video' || a.role !== 'video')) {
      fail(el, 'This clip uses a role WeftCut cannot reproduce. Assign a standard role and export again.')
    }
    const role = a.audioRole ?? (el.tag === 'audio' ? a.role : undefined) ?? 'dialogue'
    const audioRole = role.split('.')[0]
    if (audioRole !== 'dialogue' && audioRole !== 'music' && audioRole !== 'effects') {
      fail(el, 'Assign the audio to dialogue, music or effects in the source editor and export again')
    }
    if (role !== audioRole) notes.push('Audio subrole “' + role + '” is grouped under “' + audioRole + '”')
    if (asset.start.num !== 0) notes.push('Source timecode origin is normalized to file-relative source trims')
    const maps = el.children.filter(child => child.tag === 'timeMap')
    let sourceIn = subtractTime(start, asset.start)
    let sourceOut = addTime(sourceIn, duration)
    let playbackRate: ExactTime | undefined
    let preservePitch: boolean | undefined
    if (maps.length) {
      const map = maps[0]!
      check(map, ['frameSampling', 'preservesPitch'], ['timept'])
      const remedy = 'Render the speed change into a new clip in the source editor, replace this clip, and export again.'
      if (maps.length !== 1 || asset.stillImage || el.children.some(child =>
        ['asset-clip', 'video', 'audio', 'marker'].includes(child.tag))) {
        fail(map, 'This speed change includes markers, connected clips, or other timing WeftCut cannot reproduce. ' + remedy)
      }
      if ((map.attrs.frameSampling ?? 'floor') !== 'floor' || !['0', '1'].includes(map.attrs.preservesPitch ?? '1')) {
        fail(map, 'WeftCut cannot reproduce this frame interpolation or pitch setting. ' + remedy)
      }
      const [first, last] = map.children
      for (const point of [first!, last!]) check(point, ['time', 'value', 'interp'])
      const startTime = time(first!, 'time')
      const endTime = time(last!, 'time')
      const startValue = time(first!, 'value')
      const endValue = time(last!, 'value')
      if (compareTime(endTime, startTime) <= 0 || compareTime(endValue, startValue) <= 0 ||
        compareTime(start, startTime) < 0 || compareTime(addTime(start, duration), endTime) > 0) {
        fail(map, 'WeftCut can import forward constant speed when the map covers the whole clip. ' + remedy)
      }
      playbackRate = divideTime(subtractTime(endValue, startValue), subtractTime(endTime, startTime))
      sourceIn = subtractTime(addTime(startValue, multiplyTime(subtractTime(start, startTime), playbackRate)), asset.start)
      sourceOut = addTime(sourceIn, multiplyTime(duration, playbackRate))
      preservePitch = map.attrs.preservesPitch !== '0'
      notes.push('Constant playback speed is kept as an editable setting (' +
        playbackRate.num + '/' + playbackRate.den + '×).')
    }
    if (sourceIn.num < 0 || (!asset.stillImage && compareTime(sourceOut, asset.duration) > 0))
      fail(el, 'Trim lies outside the declared source range of the asset')
    if (asset.stillImage && sourceIn.num !== 0)
      fail(el, 'Still-image clips must start at 0s in the source')
    if (hasVideo && asset.videoFormat && !asset.stillImage) {
      frames(sourceIn, { ...asset.videoFormat, namedDefaults: false }, el, 'source in')
    }
    const markers = el.children.filter((child) => child.tag === 'marker').map((mark) => {
      check(mark, ['start', 'duration', 'value'])
      const markerDuration = time(mark, 'duration', format.frameDuration)
      const at = time(mark, 'start')
      const local = subtractTime(at, start)
      if (local.num < 0 || compareTime(local, duration) >= 0) fail(mark, 'Marker lies outside the clip trim')
      const timelineAt = addTime(offset, local)
      const markerFrame = divideTime(timelineAt, format.frameDuration)
      const frame = roundTime(markerFrame)
      if (markerFrame.den !== 1) notes.push('Marker “' + required(mark, 'value') + '” moved to the nearest timeline frame')
      let rangeEnd: number | null = null
      if (compareTime(markerDuration, format.frameDuration) > 0) {
        if (compareTime(addTime(local, markerDuration), duration) > 0) {
          fail(mark, 'The marker range extends past the clip trim. Shorten the marker or extend the clip.')
        }
        const rangeFrame = divideTime(addTime(timelineAt, markerDuration), format.frameDuration)
        rangeEnd = roundTime(rangeFrame)
        if (rangeFrame.den !== 1) notes.push('Marker range end moved to the nearest timeline frame')
      } else if (markerDuration.num > 0) {
        notes.push('Marker “' + required(mark, 'value') + '” becomes a point marker')
      }
      return { label: required(mark, 'value'), frame, endFrame: rangeEnd, source: subtractTime(at, asset.start) }
    })
    const clip: TimelineClip = { label: a.name || assetNode.attrs.name, enabled: a.enabled !== '0', asset, lane,
      timelineStart: offset, timelineEnd: end, firstFrame, endFrame, sourceIn, sourceOut, hasVideo, playbackRate, preservePitch,
      audioRole: !hasAudio ? null : audioRole === 'effects' ? 'sfx' : audioRole,
      conform, volumeDb, opacity, staticTransform, markers, notes, location: location(el) }
    if (parent) connected.push({ element: el, clip })
    else clips.push(clip)
  }

  for (const el of spine.children) {
    if (el.tag === 'transition') {
      const filter = dissolveFilter(el)!
      check(el, ['name', 'offset', 'duration', 'start'], ['filter-video'])
      check(filter, ['ref', 'name'])
      const from = clips.at(-1)
      if (pendingDissolve || !from || compareTime(from.timelineEnd, primaryEnd) !== 0 ||
          !from.hasVideo || from.audioRole || !from.enabled) {
        fail(el, 'A cross dissolve needs two adjacent enabled video-only clips. Render the transition in the source editor if it includes other media.')
      }
      const start = subtractTime(time(el, 'offset'), sequenceOrigin)
      const duration = time(el, 'duration')
      const end = addTime(start, duration)
      if (compareTime(start, from.timelineStart) <= 0 || compareTime(end, from.timelineEnd) !== 0) {
        fail(el, 'The cross dissolve does not match the outgoing clip’s overlap. Render it in the source editor to keep its timing.')
      }
      pendingDissolve = { el, from, start, end }
      continue
    }
    const before = clips.length
    readClip(el)
    if (!pendingDissolve) continue
    const { el: transition, from, start, end } = pendingDissolve
    pendingDissolve = undefined
    const to = clips[before]
    if (!to || !to.hasVideo || to.audioRole || !to.enabled ||
        compareTime(to.timelineStart, start) !== 0 || compareTime(to.timelineEnd, end) <= 0) {
      fail(transition, 'The cross dissolve does not match two video-only clips with an explicit overlap. Render it in the source editor to keep its timing.')
    }
    const previous = dissolves.at(-1)
    if (previous && frames(start, format, transition, 'offset') < previous.endFrame) {
      fail(transition, 'Overlapping cross dissolves need to be rendered in the source editor.')
    }
    dissolves.push({ from, to, firstFrame: frames(start, format, transition, 'offset'), endFrame: frames(end, format, transition, 'end') })
    notices.push({ location: location(transition), label: transition.attrs.name || 'Cross Dissolve', lane: 0,
      status: 'approximated', notes: ['WeftCut uses its editable crossfade over the original overlap. The blend may look slightly different.'] })
  }
  if (pendingDissolve) fail(pendingDissolve.el, 'The cross dissolve has no incoming clip. Render it in the source editor.')
  const laneEnds = new Map<number, ExactTime>()
  connected.sort((a, b) => a.clip.lane - b.clip.lane || compareTime(a.clip.timelineStart, b.clip.timelineStart))
  for (const { element, clip } of connected) {
    if (compareTime(clip.timelineStart, laneEnds.get(clip.lane) ?? ZERO_TIME) < 0)
      fail(element, 'Overlaps another clip on the same connected lane. Move one clip to a different lane')
    laneEnds.set(clip.lane, clip.timelineEnd)
    clips.push(clip)
  }
  const sequenceDuration = time(seq, 'duration', lastEnd)
  if (compareTime(sequenceDuration, lastEnd) < 0) fail(seq, 'Declared duration ends before the last storyline item')
  const frameCount = divideTime(sequenceDuration, format.frameDuration)
  const durationFrames = ceilTime(frameCount)
  if (frameCount.den !== 1) notice(seq, 'The timeline end was extended to the next video frame to contain the final audio sample')
  if (clips.length === 0) fail(spine, 'The primary storyline needs at least one asset clip')
  return { name: project.attrs.name, canvas: { width: format.width, height: format.height },
    fps: { num: fps.num, den: fps.den }, durationFrames, clips, dissolves, notices, omittedEffects,
    normalizedTimecode: sequenceOrigin.num !== 0, dropFrameTimecode: tcFormat === 'DF',
    namedFormatDefaults: format.namedDefaults, sourceColor: format.sourceColor }
}
