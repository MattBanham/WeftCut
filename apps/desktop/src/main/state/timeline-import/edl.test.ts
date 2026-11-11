import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { parseEdl } from './edl'

const edl = [
  'TITLE: Lantern Alley',
  'FCM: NON-DROP FRAME',
  '001 AX V C 10:00:00:02 10:00:00:05 01:00:00:00 01:00:00:03',
  '* FROM CLIP NAME: Lantern Take.mov',
  '002 BL V C 00:00:00:00 00:00:00:01 01:00:00:03 01:00:00:04',
  '003 AX AA/V C 10:00:00:06 10:00:00:08 01:00:00:04 01:00:00:06',
  '* FROM CLIP NAME: Lantern cut',
  '* SOURCE FILE: Lantern Take.mov',
].join('\r\n')
const options = {
  mediaDirectory: tmpdir(), fpsNum: 30000, fpsDen: 1001,
  recordOrigin: '01:00:00:00', sourceOrigin: '10:00:00:00',
}

describe('CMX 3600 EDL subset', () => {
  it('keeps record and source origins distinct, preserves black filler and maps only selected channels', () => {
    const parsed = parseEdl(edl, options)
    expect(parsed).toMatchObject({ name: 'Lantern Alley', fps: { num: 30000, den: 1001 }, durationFrames: 6 })
    expect(parsed.clips).toMatchObject([
      {
        firstFrame: 0, endFrame: 3, audioRole: null, asset: { path: join(tmpdir(), 'Lantern Take.mov') },
        sourceIn: { num: 200200, den: 3 }, sourceOut: { num: 500500, den: 3 },
      },
      {
        firstFrame: 4, endFrame: 6, audioRole: 'dialogue', label: 'Lantern cut',
        asset: { path: join(tmpdir(), 'Lantern Take.mov'), hasAudio: true, audioChannels: 2 },
        sourceIn: { num: 200200, den: 1 }, sourceOut: { num: 800800, den: 3 },
      },
    ])
  })

  it('keeps leading and trailing black from the record span', () => {
    const changed = edl + '\r\n004 BL V C 00:00:00:00 00:00:00:02 01:00:00:06 01:00:00:08'
    const parsed = parseEdl(changed, { ...options, recordOrigin: '00:59:59:29' })
    expect(parsed.clips[0]!.firstFrame).toBe(1)
    expect(parsed.durationFrames).toBe(9)
  })

  it.each([
    ['drop-frame list', 'FCM: NON-DROP FRAME', 'FCM: DROP FRAME', /non-drop-frame CMX/],
    ['drop-frame event', '10:00:00:02', '10:00:00;02', /non-drop-frame timecode/],
    ['invalid frame number', '10:00:00:02', '10:00:00:30', /selected rate/],
    ['unequal spans', '10:00:00:05', '10:00:00:06', /equal, positive frame ranges/],
    ['overlap', '01:00:00:04 01:00:00:06', '01:00:00:03 01:00:00:05', /overlaps or is out of record order/],
    ['source before origin', '10:00:00:02 10:00:00:05', '09:59:59:29 10:00:00:02', /precedes the supplied media origin/],
    ['dissolve', 'AX V C', 'AX V D 024', /unsupported line/],
    ['standalone audio', 'AX AA/V C', 'AX AA C', /select one video track/],
    ['missing file comment', '* FROM CLIP NAME: Lantern Take.mov', '', /exact original filename/],
    ['filename outside media folder', 'SOURCE FILE: Lantern Take.mov', 'SOURCE FILE: ../Lantern Take.mov', /exact original filename/],
    ['duplicate event', '003 AX', '001 AX', /repeated event/],
    ['unmapped markers', '* FROM CLIP NAME: Lantern Take.mov', '* LOC: 01:00:00:00 RED Cue', /unsupported line/],
  ])('refuses %s', (_reason, before, after, diagnostic) => {
    expect(() => parseEdl(edl.replace(before, after), options)).toThrow(diagnostic)
  })

  it('requires the caller to supply the rate and each origin', () => {
    expect(() => parseEdl(edl, undefined)).toThrow(/frame rate, timecode origins and media folder/)
    expect(() => parseEdl(edl, { ...options, fpsNum: 2997, fpsDen: 100 })).toThrow(/exact frame rate/)
    expect(() => parseEdl(edl, { ...options, sourceOrigin: '' })).toThrow(/Source origin/)
    expect(() => parseEdl(edl, { ...options, recordOrigin: '01:00:00:01' })).toThrow(/record in precedes/)
  })
})
