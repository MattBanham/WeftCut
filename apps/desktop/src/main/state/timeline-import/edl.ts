import { extname, isAbsolute, join } from 'node:path'
import { FPS_OPTIONS } from '../../../shared/newProject'
import { frameIndexRound, parseTimecode } from '../../../renderer/frames'
import { exactTime, multiplyTime } from '../../../renderer/timeMapping'
import type { Rational } from '../model'
import type { ImportTimeline, TimelineClip } from './timeline'

interface Cut {
  location: string
  reel: string
  channels: number
  sourceIn: number
  sourceOut: number
  firstFrame: number
  endFrame: number
  clipName?: string
  fileName?: string
}

const timecode = /^\d\d:[0-5]\d:[0-5]\d:\d\d$/

function readTimecode(value: unknown, fps: Rational, location: string): number {
  const us = typeof value === 'string' && timecode.test(value) ? parseTimecode(value, fps.num, fps.den) : null
  if (us === null) throw new Error(location + ': enter non-drop-frame timecode as HH:MM:SS:FF at the selected rate')
  return frameIndexRound(us, fps.num, fps.den)
}

export function parseEdl(text: string, options: unknown): ImportTimeline {
  if (typeof options !== 'object' || options === null) throw new Error('Choose the EDL frame rate, timecode origins and media folder')
  const { fpsNum, fpsDen, recordOrigin, sourceOrigin, mediaDirectory } = options as Record<string, unknown>
  const rate = FPS_OPTIONS.find((fps) => fps.num === fpsNum && fps.den === fpsDen)
  if (!rate) throw new Error('Choose the exact frame rate used to export the EDL')
  if (typeof mediaDirectory !== 'string' || !isAbsolute(mediaDirectory)) throw new Error('Choose the folder containing the original media')
  const folder = mediaDirectory
  const fps = { num: rate.num, den: rate.den }
  const recordStart = readTimecode(recordOrigin, fps, 'Record origin')
  const sourceStart = readTimecode(sourceOrigin, fps, 'Source origin')
  const sourceFrame = exactTime(1_000_000 * fps.den, fps.num)
  const sourceTime = (frame: number) => multiplyTime(exactTime(frame), sourceFrame)
  const clips: TimelineClip[] = []
  let current: Cut | undefined
  let lastEnd = 0
  let name: string | undefined
  let hasFcm = false
  const eventIds = new Set<number>()

  function finishCut(cut: Cut): void {
    if (cut.reel === 'BL') {
      if (cut.channels > 0) throw new Error(cut.location + ': black filler cannot select audio channels')
      return
    }
    const file = cut.fileName ?? cut.clipName
    if (!file || file === '.' || file === '..' || !extname(file) || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(file)) {
      throw new Error(cut.location + ': specify the exact original filename and extension in a SOURCE FILE or FROM CLIP NAME comment')
    }
    if (cut.sourceIn < sourceStart) throw new Error(cut.location + ': source in precedes the supplied media origin')
    clips.push({
      label: cut.clipName ?? file,
      asset: { ref: cut.reel, path: join(folder, file),
        ...(cut.channels > 0 ? { hasAudio: true, audioChannels: cut.channels } : {}) },
      firstFrame: cut.firstFrame, endFrame: cut.endFrame,
      sourceIn: sourceTime(cut.sourceIn - sourceStart), sourceOut: sourceTime(cut.sourceOut - sourceStart),
      audioRole: cut.channels > 0 ? 'dialogue' : null,
      markers: [], location: cut.location,
    })
  }

  for (const [index, raw] of text.split(/\r\n?|\n/).entries()) {
    const line = raw.trim()
    if (!line) continue
    const at = 'EDL line ' + (index + 1)
    const title = /^TITLE:\s*(.+)$/i.exec(line)
    if (title && !current && name === undefined) {
      name = title[1]!.trim()
      continue
    }
    if (/^FCM:/i.test(line)) {
      if (current || hasFcm || !/^FCM:\s*NON-DROP FRAME$/i.test(line))
        throw new Error(at + ': export one non-drop-frame CMX 3600 list')
      hasFcm = true
      continue
    }
    const comment = /^\*\s*(FROM CLIP NAME|SOURCE FILE):\s*(.+)$/i.exec(line)
    if (comment) {
      if (!current) throw new Error(at + ': media comments must follow an edit event')
      const key = comment[1]!.toUpperCase() === 'SOURCE FILE' ? 'fileName' : 'clipName'
      if (current[key] !== undefined) throw new Error(at + ': this event has more than one ' + comment[1]!.toLowerCase() + ' comment')
      current[key] = comment[2]!.trim()
      continue
    }
    const event = /^(\d{3})\s+(\S+)\s+(\S+)\s+C\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/i.exec(line)
    if (!event) throw new Error(at + ': unsupported line. Export a CMX 3600 list with straight cuts and media filename comments')
    if (!hasFcm) throw new Error(at + ': add the FCM: NON-DROP FRAME header before the first edit')
    if (current) finishCut(current)
    const [, id, reel, track, si, so, ri, ro] = event
    const location = at + ' (event ' + id + ', reel ' + reel + ')'
    if (eventIds.has(Number(id))) throw new Error(location + ': repeated event numbers are unsupported')
    eventIds.add(Number(id))
    const channel = track!.toUpperCase()
    if (channel !== 'V' && channel !== 'A/V' && channel !== 'AA/V')
      throw new Error(location + ': select one video track with optional linked mono or stereo audio')
    const firstFrame = readTimecode(ri, fps, location) - recordStart
    const endFrame = readTimecode(ro, fps, location) - recordStart
    if (firstFrame < 0) throw new Error(location + ': record in precedes the supplied timeline origin')
    if (firstFrame < lastEnd) throw new Error(location + ': the edit overlaps or is out of record order')
    const sourceIn = readTimecode(si, fps, location)
    const sourceOut = readTimecode(so, fps, location)
    if (firstFrame >= endFrame || endFrame - firstFrame !== sourceOut - sourceIn)
      throw new Error(location + ': the source and record spans must be equal, positive frame ranges')
    current = { location, reel: reel!.toUpperCase(), channels: channel === 'V' ? 0 : channel === 'A/V' ? 1 : 2,
      sourceIn, sourceOut, firstFrame, endFrame }
    lastEnd = endFrame
  }
  if (current) finishCut(current)
  if (!clips.length) throw new Error('The EDL must contain at least one video cut with original media')
  return { name, fps, durationFrames: lastEnd, clips }
}
