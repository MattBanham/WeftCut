import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SaxesParser } from 'saxes'
import { canvasSizeError, FPS_OPTIONS } from '../../../shared/newProject'
import type { ExactTime } from '../../../shared/timeMapping'
import { TimeMappingError } from '../../../shared/timeMapping'
import { addTime, compareTime, divideTime, exactTime, multiplyTime, subtractTime, ZERO_TIME } from '../../../renderer/timeMapping'
import type { ImportTimeline, TimelineClip, TimelineSource } from './timeline'

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
}

interface Format {
  width: number
  height: number
  frameDuration: ExactTime
  paspH: number
  paspV: number
  namedDefaults: boolean
}

export const FCPXML_LIMITS = {
  bytes: 16 * 1024 * 1024,
  depth: 24,
  elements: 50_000,
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
    if (value.trim()) fail(stack[stack.length - 1]!, 'Unexpected text')
  }
  parser.on('text', text)
  parser.on('cdata', text)
  parser.write(xml).close()
  const root = document.children[0]
  if (!root || root.tag !== 'fcpxml') throw new Error('Choose a .fcpxml document with an <fcpxml> root')
  return root
}

function check(el: Element, attrs: readonly string[], children: readonly string[] = []) {
  for (const name of Object.keys(el.attrs)) {
    if (!attrs.includes(name)) fail(el, `Unsupported attribute "${name}". Remove it or simplify the edit and export again`)
  }
  for (const child of el.children) {
    if (!children.includes(child.tag)) {
      fail(child, `Unsupported inside <${el.tag}>. Export a single primary storyline with straight cuts, gaps and clip markers`)
    }
  }
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

function parseFormat(el: Element, sourceFormat = false): Format {
  check(el, ['id', 'name', 'frameDuration', 'width', 'height', 'colorSpace', 'fieldOrder', 'paspH', 'paspV'])
  const a = el.attrs
  if ((a.colorSpace !== undefined && !/^1-1-1(?:\s|$)/.test(a.colorSpace)) ||
      (a.fieldOrder !== undefined && a.fieldOrder !== 'progressive')) {
    fail(el, 'Only progressive Rec. 709 formats are supported; HDR, alternate transfer functions and interlace require an explicit conversion pipeline')
  }
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
  if (canvasSizeError(width, height)) fail(el, 'The canvas must be an even-sized WeftCut canvas within the supported resolution range')
  const frameDuration = a.frameDuration === undefined ? preset!.frameDuration : time(el, 'frameDuration')
  if (frameDuration.num <= 0) fail(el, 'Video frameDuration must be positive')
  return { width, height, frameDuration, paspH, paspV, namedDefaults }
}

function localPath(el: Element): string {
  const src = required(el, 'src')
  try {
    if (!/^file:\/\/[^\\]/i.test(src) || /[\x00-\x1f\x7f\\]/.test(src)) throw new Error()
    if (decodeURIComponent(src).split(/[\\/]/).some(part => part === '.' || part === '..')) throw new Error()
    const url = new URL(src)
    if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) throw new Error()
    const path = fileURLToPath(url)
    if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error()
    return path
  } catch {
    return fail(el, 'Media must use an absolute local file URL. Relink the original file in the source editor and export again')
  }
}

function parseAsset(el: Element, lookup: (ref: string, tag: string, from: Element) => Element): Asset {
  check(el, ['id', 'name', 'uid', 'src', 'start', 'duration', 'hasVideo', 'hasAudio', 'format',
    'audioSources', 'audioChannels', 'audioRate', 'videoSources'], ['media-rep'])
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
  if (a.format !== undefined) {
    if (!hasVideo) fail(el, 'Audio-only assets must not refer to a video format')
    const formatNode = lookup(a.format, 'format', el)
    if (stillImage) {
      check(formatNode, ['id', 'name', 'frameDuration', 'width', 'height', 'colorSpace', 'fieldOrder', 'paspH', 'paspV'])
      if (integer(formatNode, 'width') === 0 || integer(formatNode, 'height') === 0)
        fail(formatNode, 'Still-image dimensions must be positive')
    } else {
      const source = parseFormat(formatNode, true)
      videoFormat = { width: source.width, height: source.height, frameDuration: source.frameDuration,
        paspH: source.paspH, paspV: source.paspV }
    }
  }
  let path: string
  if (a.src !== undefined && el.children.length === 0) {
    path = localPath(el)
  } else {
    if (a.src !== undefined) fail(el, 'The asset names multiple media representations')
    const rep = one(el, 'media-rep')
    check(rep, ['kind', 'src', 'sig'])
    if ((rep.attrs.kind ?? 'original-media') !== 'original-media') fail(rep, 'Relink the original media and export again')
    path = localPath(rep)
  }
  if (duration.num === 0 && !stillImage) fail(el, 'Asset duration must be positive')
  return { ref: required(el, 'id'), path, start: time(el, 'start', ZERO_TIME), duration,
    hasVideo, hasAudio, stillImage, videoFormat, audioChannels, audioRate }
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
    check(event, ['name', 'uid'], ['project'])
    for (const project of event.children) projects.push({ project, event: event.attrs.name ?? null })
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

export function parseFcpxml(xml: string, sequenceIndex?: number): ImportTimeline {
  try { return parseDocument(readXml(xml), sequenceIndex) }
  catch (error) {
    if (error instanceof TimeMappingError) throw new Error(`FCPXML timing is outside the supported range (${error.code})`)
    throw error
  }
}

function parseDocument(root: Element, sequenceIndex?: number): ImportTimeline {
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
  check(spine, [], ['gap', 'asset-clip'])
  const clips: TimelineClip[] = []
  const assets = new Map<string, Asset>()
  let primaryEnd = 0
  let lastEnd = 0
  const connected: { element: Element; clip: TimelineClip }[] = []

  function readClip(el: Element, parent?: { offset: ExactTime; start: ExactTime }) {
    const a = el.attrs
    const gap = el.tag === 'gap'
    check(el, gap
      ? ['name', 'lane', 'offset', 'start', 'duration']
      : ['name', 'lane', 'offset', 'start', 'duration', 'ref', 'enabled', 'audioRole', 'videoRole', 'format', 'tcFormat'],
    parent ? ['marker', 'adjust-conform', 'adjust-volume', 'adjust-transform', 'adjust-blend']
      : gap ? ['asset-clip', 'video']
        : ['marker', 'asset-clip', 'video', 'adjust-conform', 'adjust-volume', 'adjust-transform', 'adjust-blend'])
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
    const firstFrame = frames(offset, format, el, 'offset')
    const duration = time(el, 'duration')
    const endFrame = frames(addTime(offset, duration), format, el, 'end')
    if (endFrame <= firstFrame) fail(el, 'Duration must span at least one video frame')
    if (!parent) {
      if (firstFrame < primaryEnd) fail(el, 'Overlaps the preceding item. Remove the overlap or transition and export again')
      primaryEnd = endFrame
    }
    lastEnd = Math.max(lastEnd, endFrame)
    const start = time(el, 'start', ZERO_TIME)
    for (const child of el.children) {
      if (child.tag === 'asset-clip' || child.tag === 'video') readClip(child, { offset, start })
    }
    if (gap) return
    if ((a.enabled ?? '1') !== '1' || (a.tcFormat !== undefined && a.tcFormat !== 'NDF' && a.tcFormat !== 'DF') ||
        (a.videoRole ?? 'video') !== 'video') {
      fail(el, 'Disabled clips, invalid clip timecode and custom video roles are unsupported')
    }
    const ref = required(el, 'ref')
    const assetNode = lookup(ref, 'asset', el)
    let asset = assets.get(ref)
    if (!asset) {
      asset = parseAsset(assetNode, lookup)
      assets.set(ref, asset)
    }
    if (asset.stillImage && el.tag !== 'video')
      fail(el, 'Still-image assets must be placed with a <video> clip')
    if ((lane < 0 && asset.hasVideo) || (lane > 0 && !asset.hasVideo))
      fail(el, 'Place connected video in positive lanes and connected audio-only clips in negative lanes')
    if (a.format !== undefined && a.format !== assetNode.attrs.format && a.format !== seq.attrs.format) {
      fail(el, 'Clip format differs from both the asset and sequence format')
    }
    const conformance = el.children.filter(child => child.tag === 'adjust-conform')
    if (conformance.length > 1) fail(el, 'Only one spatial conform operation is supported')
    let conform: 'fit' | 'fill' | 'none' = 'fit'
    if (conformance.length) {
      const operation = conformance[0]!
      check(operation, ['type'])
      conform = (operation.attrs.type ?? 'fit') as typeof conform
      if (!['fit', 'fill', 'none'].includes(conform)) fail(operation, 'Spatial conform must be fit, fill or none')
      if (!asset.hasVideo || asset.stillImage) fail(operation, 'Spatial conform currently supports only moving video clips')
    }
    const volumeOps = el.children.filter(child => child.tag === 'adjust-volume')
    if (volumeOps.length > 1) fail(el, 'Only one static volume operation is supported')
    let volumeDb = 0
    if (volumeOps.length) {
      const operation = volumeOps[0]!
      check(operation, ['amount'])
      if (!asset.hasAudio) fail(operation, 'Volume adjustment requires source audio')
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
    if ((!asset.hasVideo || asset.stillImage && el.tag !== 'video') &&
        (transformOps.length || blendOps.length)) {
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
    const audioRole = a.audioRole ?? 'dialogue'
    if (audioRole !== 'dialogue' && audioRole !== 'music' && audioRole !== 'effects')
      fail(el, 'Use the standard dialogue, music or effects audio role')
    const sourceIn = subtractTime(start, asset.start)
    const sourceOut = addTime(sourceIn, duration)
    if (sourceIn.num < 0 || (!asset.stillImage && compareTime(sourceOut, asset.duration) > 0))
      fail(el, 'Trim lies outside the declared source range of the asset')
    if (asset.stillImage && sourceIn.num !== 0)
      fail(el, 'Still-image clips must start at 0s in the source')
    if (asset.videoFormat && !asset.stillImage) {
      frames(sourceIn, { ...asset.videoFormat, namedDefaults: false }, el, 'source in')
    }
    const markers = el.children.filter((child) => child.tag === 'marker').map((mark) => {
      check(mark, ['start', 'duration', 'value'])
      if (compareTime(time(mark, 'duration', format.frameDuration), format.frameDuration) !== 0)
        fail(mark, 'Only single-frame clip markers are supported')
      const at = time(mark, 'start')
      const local = subtractTime(at, start)
      if (local.num < 0 || compareTime(local, duration) >= 0) fail(mark, 'Marker lies outside the clip trim')
      return { label: required(mark, 'value'), frame: firstFrame + frames(local, format, mark, 'start'),
        source: subtractTime(at, asset.start) }
    })
    const clip: TimelineClip = { label: a.name || assetNode.attrs.name, asset, lane, firstFrame, endFrame, sourceIn, sourceOut,
      audioRole: !asset.hasAudio ? null : audioRole === 'effects' ? 'sfx' : audioRole,
      conform, volumeDb, opacity, staticTransform, markers, location: location(el) }
    if (parent) connected.push({ element: el, clip })
    else clips.push(clip)
  }

  for (const el of spine.children) readClip(el)
  const laneEnds = new Map<number, number>()
  connected.sort((a, b) => a.clip.lane - b.clip.lane || a.clip.firstFrame - b.clip.firstFrame)
  for (const { element, clip } of connected) {
    if (clip.firstFrame < (laneEnds.get(clip.lane) ?? 0))
      fail(element, 'Overlaps another clip on the same connected lane. Move one clip to a different lane')
    laneEnds.set(clip.lane, clip.endFrame)
    clips.push(clip)
  }
  const durationFrames = seq.attrs.duration === undefined ? lastEnd : frames(time(seq, 'duration'), format, seq, 'duration')
  if (durationFrames < lastEnd) fail(seq, 'Declared duration ends before the last storyline item')
  if (clips.length === 0) fail(spine, 'The primary storyline needs at least one asset clip')
  return { name: project.attrs.name, canvas: { width: format.width, height: format.height },
    fps: { num: fps.num, den: fps.den }, durationFrames, clips,
    normalizedTimecode: sequenceOrigin.num !== 0, dropFrameTimecode: tcFormat === 'DF',
    namedFormatDefaults: format.namedDefaults }
}
