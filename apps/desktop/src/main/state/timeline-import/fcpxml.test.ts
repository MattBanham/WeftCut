import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceIn, sourceOut } from '../../../renderer/layerTiming'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject, rootComposition } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { PROJECT_FILE } from '../persistence'
import { AUDIO_GRID, isCanonicalOnGrid } from '../snap'
import { validate } from '../validate'
import { parseFcpxml } from './fcpxml'
import { prepareTimelineProject, publishTimelineProject } from './project'

const fixture = (url = 'file:///fictional/Harbor%20Lights.mov') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="format" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="take" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2"
        audioRate="48000" format="format" start="3600s" duration="10s">
      <media-rep kind="original-media" src="${url}"/>
    </asset>
  </resources>
  <project name="Harbor &amp; Lights">
    <sequence format="format" duration="6006/30000s" tcStart="0s" tcFormat="NDF">
      <spine>
        <asset-clip ref="take" name="Signal" start="108002002/30000s" duration="3003/30000s">
          <marker value="Signal seen" start="108003003/30000s" duration="1001/30000s"/>
        </asset-clip>
        <gap offset="3003/30000s" duration="1001/30000s"/>
        <asset-clip ref="take" name="Dock" offset="4004/30000s" start="108006006/30000s"
          duration="2002/30000s" audioRole="music"/>
      </spine>
    </sequence>
  </project>
</fcpxml>`

const voiceScriptStillFixture = (audioUrl: string, imageUrl: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1/60s" width="320" height="240"/>
    <format id="still" name="FFVideoFormatRateUndefined" width="120" height="130"/>
    <asset id="narration" name="Narration" start="0s" duration="2s" hasAudio="1" audioSources="1" audioChannels="1">
      <media-rep kind="original-media" src="${audioUrl}"/>
    </asset>
    <asset id="mouth" name="Mouth A" start="0s" duration="0s" hasVideo="1" videoSources="1" format="still">
      <media-rep kind="original-media" src="${imageUrl}"/>
    </asset>
  </resources>
  <library><event name="VoiceScript"><project name="VoiceScript test">
    <sequence format="f" duration="120/60s" tcStart="0s" tcFormat="NDF" audioLayout="mono" audioRate="48k">
      <spine>
        <gap offset="0s" start="0s" duration="120/60s">
          <asset-clip ref="narration" lane="-1" offset="0s" start="0s" duration="120/60s" audioRole="dialogue"/>
          <video ref="mouth" lane="1" name="A" offset="30/60s" start="0s" duration="60/60s"/>
        </gap>
      </spine>
    </sequence>
  </project></event></library>
</fcpxml>`

describe('FCPXML subset', () => {
  it('keeps fractional frames, source timecode origin and marker time distinct', () => {
    const url = pathToFileURL(join(tmpdir(), 'Harbor Lights.mov')).href
    const parsed = parseFcpxml(fixture(url))
    expect(parsed).toMatchObject({ name: 'Harbor & Lights', fps: { num: 30000, den: 1001 }, durationFrames: 6 })
    expect(parsed.clips[0]).toMatchObject({
      firstFrame: 0, endFrame: 3,
      asset: { path: join(tmpdir(), 'Harbor Lights.mov') },
      sourceIn: { num: 200200, den: 3 }, sourceOut: { num: 500500, den: 3 },
      markers: [{ label: 'Signal seen', frame: 1, source: { num: 100100, den: 1 } }],
    })
    expect(parsed.clips[1]).toMatchObject({ firstFrame: 4, endFrame: 6, audioRole: 'music' })
  })

  it('accepts legacy asset URLs and a single library/event/project wrapper', () => {
    const url = pathToFileURL(join(tmpdir(), 'Harbor Lights.mov')).href
    const xml = fixture(url).replace('version="1.10"', 'version="1.8"')
      .replace(/duration="10s">\s*<media-rep[^>]+\/>\s*<\/asset>/, `duration="10s" src="${url}"/>`)
      .replace('<project name=', '<library><event name="Fictional Event"><project name=')
      .replace('</project>', '</project></event></library>')
    expect(parseFcpxml(xml).clips).toHaveLength(2)
  })

  it('translates connected offsets from the trimmed parent clock and validates lane collisions', () => {
    const url = pathToFileURL(join(tmpdir(), 'Harbor Lights.mov')).href
    const child = '<asset-clip ref="take" name="Overlay" lane="2" offset="108003003/30000s" start="108006006/30000s" duration="2002/30000s"/>'
    const xml = fixture(url).replace('<marker ', child + '<marker ')
    const parsed = parseFcpxml(xml)
    expect(parsed.clips.map((clip) => [clip.lane, clip.firstFrame, clip.endFrame])).toEqual([[0, 0, 3], [0, 4, 6], [2, 1, 3]])
    expect(() => parseFcpxml(xml.replace(child, child + child))).toThrow(/same connected lane/)
    expect(() => parseFcpxml(xml.replace('offset="108003003/30000s"', 'offset="0s"'))).toThrow(/before the timeline origin/)
  })

  it('accepts VoiceScript mono narration and still PNG visemes as connected image clips', () => {
    const xml = voiceScriptStillFixture('file:///fictional/narration.wav', 'file:///fictional/mouth.png')
    const parsed = parseFcpxml(xml)
    expect(parsed).toMatchObject({
      name: 'VoiceScript test', fps: { num: 60, den: 1 }, durationFrames: 120,
    })
    expect(parsed.clips).toHaveLength(2)
    expect(parsed.clips.map((clip) => [clip.lane, clip.firstFrame, clip.endFrame])).toEqual([
      [-1, 0, 120],
      [1, 30, 90],
    ])
    expect(parsed.clips[0]!.asset).toMatchObject({ hasAudio: true, audioChannels: 1, stillImage: false })
    expect(parsed.clips[1]!.asset).toMatchObject({ hasVideo: true, hasAudio: false, stillImage: true })
    expect(parseFcpxml(xml.replace('audioLayout="mono"', 'audioLayout="surround"')).clips).toHaveLength(2)
    expect(parseFcpxml(xml.replace('audioRate="48k"', 'audioRate="44.1k"')).clips).toHaveLength(2)
    expect(() => parseFcpxml(xml.replace('audioLayout="mono"', 'audioLayout="unknown"')))
      .toThrow(/Unsupported sequence audio layout/)
    expect(() => parseFcpxml(xml.replace('audioRate="48k"', 'audioRate="unknown"')))
      .toThrow(/Invalid audio sample rate/)
    expect(() => parseFcpxml(xml.replace('<video ref="mouth"', '<asset-clip ref="mouth"')))
      .toThrow(/Still-image assets must be placed with a <video>/)
  })

  it('does not invent audio for a video-only timeline, even with no sequence audio attributes', () => {
    const xml = fixture().replace(
      'hasAudio="1" audioSources="1" audioChannels="2"\n        audioRate="48000"',
      'hasAudio="0" audioSources="0" audioChannels="0"\n        audioRate="0"',
    )
    const parsed = parseFcpxml(xml)
    expect(parsed.clips).toHaveLength(2)
    expect(parsed.clips.every((clip) => clip.audioRole === null && !clip.asset.hasAudio)).toBe(true)
  })

  it('accepts a supported surround source for explicit 48 kHz stereo downmixing', async () => {
    const xml = fixture().replace('audioChannels="2"', 'audioChannels="6"')
      .replace('audioRate="48000"', 'audioRate="96000"')
      .replace('tcFormat="NDF"', 'tcFormat="NDF" audioLayout="surround" audioRate="96k"')
    const parsed = parseFcpxml(xml)
    expect(parsed.clips[0]!.asset).toMatchObject({ audioChannels: 6, audioRate: 96000 })
  })

  it.each([
    ['malformed XML', (xml: string) => xml.replace('</sequence>', '</clip>'), /Malformed FCPXML/],
    ['an external DTD', (xml: string) => xml.replace('DOCTYPE fcpxml', 'DOCTYPE fcpxml SYSTEM "file:///fictional/other.dtd"'), /plain.*DOCTYPE/],
    ['drop-frame timecode', (xml: string) => xml.replace('tcFormat="NDF"', 'tcFormat="DF"'), /zero-start non-drop-frame/],
    ['non-zero sequence timecode', (xml: string) => xml.replace('tcStart="0s"', 'tcStart="3600s"'), /zero-start non-drop-frame/],
    ['a connected clip', (xml: string) => xml.replace('name="Dock"', 'name="Dock" lane="1"'), /Connected clips/],
    ['a transition', (xml: string) => xml.replace('<gap ', '<transition '), /<transition>.*Unsupported/],
    ['a retime', (xml: string) => xml.replace('<marker ', '<timeMap/><marker '), /<timeMap>.*Unsupported/],
    ['multiple media representations', (xml: string) => xml.replace('</asset>', '<media-rep kind="proxy-media" src="file:///fictional/proxy.mov"/></asset>'), /exactly one.*media-rep/],
    ['a remote file', (xml: string) => xml.replace(/src="file:[^"]+"/, 'src="https://example.invalid/take.mov"'), /absolute local file URL/],
    ['a gap overlapping a clip', (xml: string) => xml.replace('offset="3003/30000s"', 'offset="2002/30000s"'), /Overlaps the preceding/],
    ['a subframe cut', (xml: string) => xml.replace('offset="4004/30000s"', 'offset="4005/30000s"'), /between frames/],
    ['an out-of-bounds trim', (xml: string) => xml.replace('108006006/30000s', '3610s'), /outside the declared source range/],
    ['duplicate IDs', (xml: string) => xml.replace('id="take"', 'id="format"'), /Duplicate resource ID/],
  ])('refuses %s with a diagnostic', (_reason, change, error) => {
    const url = pathToFileURL(join(tmpdir(), 'Harbor Lights.mov')).href
    expect(() => parseFcpxml(change(fixture(url)))).toThrow(error)
  })
})

describe('timeline import transaction', () => {
  let parent: string
  let document: string
  let media: string
  let destination: string
  const id = '00000000-0000-0000-0000-0000000000ab'

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'weftcut-timeline-'))
    document = join(parent, 'Harbor.fcpxml')
    media = join(parent, 'Harbor Lights.mov')
    destination = join(parent, 'Imported Harbor')
    await writeFile(document, fixture(pathToFileURL(media).href))
  })
  afterEach(async () => { await rm(parent, { recursive: true, force: true }) })

  function setup(duration = 10_000_000, audio: { channels: number; sample_rate: number } | null = { channels: 2, sample_rate: 48000 }) {
    const idGen = seededGen()
    const before = blankProject(idGen, 'Existing Project')
    const actor = createActor({ idGen, initial: before })
    const commitWorkspace = vi.fn(async (_dir: string) => {})
    const pushRecent = vi.fn()
    const enqueueDerivatives = vi.fn()
    const deps = { actor, join, napi: { commitWorkspace, pushRecent }, enqueueDerivatives }
    const probeMedia = vi.fn(async () => JSON.stringify({
      ...mediaItemTemplate(id, 'Video', duration, true), path_abs: media, file_hash_blake3: `pending-${id}`,
      metadata: {
        duration_us: duration, video: { width: 320, height: 240, fps_num: 30000, fps_den: 1001 },
        audio,
      },
    }))
    const hashMediaSource = vi.fn(async () => 'a'.repeat(64))
    const assertCurrent = vi.fn()
    const prepareReview = () => prepareTimelineProject(document, destination, undefined, idGen, {
      compute: { probeMedia, hashMediaSource },
      statPath: (file) => existsSync(file) && statSync(file).isFile() ? { kind: 'file', readable: true } : null,
    }, assertCurrent)
    const prepare = async () => (await prepareReview()).project
    return { prepare, prepareReview, deps, before, actor, probeMedia, hashMediaSource, commitWorkspace, pushRecent, enqueueDerivatives }
  }

  it('publishes a validated editable project with exact trims, sample-aligned audio and clip markers', async () => {
    await writeFile(media, 'Fictional video')
    const run = setup()
    const project = await run.prepare()
    expect(run.actor.snapshot()).toBe(run.before)
    expect(existsSync(destination)).toBe(false)
    expect(run.probeMedia).toHaveBeenCalledOnce()
    expect(run.hashMediaSource).toHaveBeenCalledOnce()
    expect(() => validate(project)).not.toThrow()
    const root = rootComposition(project)
    const video = root.tracks[0]!.layers.filter((l) => l.params.kind === 'VideoClip')
    const audio = root.tracks[0]!.layers.filter((l) => l.params.kind === 'Audio')
    expect(root.duration_us).toBe(200200)
    expect(video.map((l) => [l.t_start_us, l.t_end_us])).toEqual([[0, 100100], [133467, 200200]])
    expect(sourceIn(video[0]!.params)).toEqual({ num: 200200, den: 3 })
    expect(sourceOut(video[0]!)).toEqual({ num: 500500, den: 3 })
    expect(audio.every((l) => isCanonicalOnGrid(l.t_start_us, AUDIO_GRID) && isCanonicalOnGrid(l.t_end_us, AUDIO_GRID))).toBe(true)
    expect(audio[1]!.t_end_us).toBeLessThanOrEqual(root.duration_us)
    expect(root.links.map((link) => link.members)).toEqual(video.map((layer, i) => [layer.id, audio[i]!.id].sort()))
    expect(root.markers[0]).toMatchObject({ t_us: 33367, label: 'Signal seen', anchor: { layer: video[0]!.id, src_us: 100100 } })
    await publishTimelineProject(run.deps, destination, project)
    expect(run.commitWorkspace).toHaveBeenCalledWith(destination)
    expect(run.enqueueDerivatives).toHaveBeenCalledWith(project)
    expect(run.actor.snapshot()).toBe(project)
    expect(readFileSync(join(destination, PROJECT_FILE), 'utf8')).toContain('Signal seen')
    expect(run.actor.command('update_layer', { layerId: video[0]!.id, patch: { label: 'Signal edited' } }).ok).toBe(true)
  })

  it('keeps the last frame when the exact source out rounds down to the probed file end', async () => {
    await writeFile(media, 'Fictional video')
    const run = setup(166833)
    const url = pathToFileURL(media).href
    const xml = fixture(url).replace(/        <gap[^\n]+\n        <asset-clip[^]*?audioRole="music"\/>\n/, '')
    await writeFile(document, xml)
    const { project, report } = await run.prepareReview()
    expect(report.roundedEnds).toBe(1)
    const video = rootComposition(project).tracks[0]!.layers.find((layer) => layer.params.kind === 'VideoClip')!
    expect(sourceOut(video)).toEqual({ num: 166833, den: 1 })
    expect(video.t_end_us).toBe(100100)
    expect(() => validate(project)).not.toThrow()
  })

  it('preflights missing media before probing or creating any project folder', async () => {
    const run = setup()
    await expect(run.prepare()).rejects.toThrow(/Missing or unreadable original media.*Harbor Lights/)
    expect(run.probeMedia).not.toHaveBeenCalled()
    expect(run.actor.snapshot()).toBe(run.before)
    expect(existsSync(destination)).toBe(false)
  })

  it('leaves the current project and disk untouched on a hash or source-range failure', async () => {
    await writeFile(media, 'Fictional video')
    const run = setup(90_000)
    await expect(run.prepare()).rejects.toThrow(/trim exceeds the probed duration/)
    run.hashMediaSource.mockRejectedValueOnce(new Error('source read failed'))
    await expect(run.prepare()).rejects.toThrow(/source read failed/)
    expect(run.actor.snapshot()).toBe(run.before)
    expect(existsSync(destination)).toBe(false)
  })

  it('imports a video-only edit without inventing an audio track', async () => {
    await writeFile(document, fixture(pathToFileURL(media).href)
      .replace('hasAudio="1" audioSources="1" audioChannels="2"\n        audioRate="48000"',
        'hasAudio="0" audioSources="0" audioChannels="0"\n        audioRate="0"'))
    await writeFile(media, 'Fictional silent video')
    const { prepareReview } = setup(10_000_000, null)
    const { project, report } = await prepareReview()
    expect(report).toMatchObject({ videoClips: 2, audioClips: 0, downmixedAudioClips: 0, resampledAudioClips: 0 })
    expect(rootComposition(project).tracks.flatMap((track) => track.layers).every((layer) => layer.params.kind === 'VideoClip')).toBe(true)
  })

  it('warns before resampling 96 kHz and downmixing six-channel audio', async () => {
    await writeFile(document, fixture(pathToFileURL(media).href)
      .replace('audioChannels="2"', 'audioChannels="6"')
      .replace('audioRate="48000"', 'audioRate="96000"')
      .replace('tcFormat="NDF"', 'tcFormat="NDF" audioLayout="surround" audioRate="96k"'))
    await writeFile(media, 'Fictional six-channel video')
    const { prepareReview } = setup(10_000_000, { channels: 6, sample_rate: 96000 })
    const { project, report } = await prepareReview()
    expect(report).toMatchObject({ videoClips: 2, audioClips: 2, resampledAudioClips: 2, downmixedAudioClips: 2 })
    expect(() => validate(project)).not.toThrow()
  })

  it('preserves a folder created during preparation', async () => {
    await writeFile(media, 'Fictional video')
    const run = setup()
    const project = await run.prepare()
    await mkdir(destination)
    await writeFile(join(destination, PROJECT_FILE), 'other project')
    await expect(publishTimelineProject(run.deps, destination, project)).rejects.toThrow(/folder already exists/)
    expect(readFileSync(join(destination, PROJECT_FILE), 'utf8')).toBe('other project')
    expect(run.commitWorkspace).not.toHaveBeenCalled()
    expect(run.actor.snapshot()).toBe(run.before)
  })

  it('rolls back the new folder when the workspace cannot be opened', async () => {
    await writeFile(media, 'Fictional video')
    const run = setup()
    const project = await run.prepare()
    run.commitWorkspace.mockRejectedValueOnce(new Error('cache is unavailable'))
    await expect(publishTimelineProject(run.deps, destination, project)).rejects.toThrow(/cache is unavailable/)
    expect(run.actor.snapshot()).toBe(run.before)
    expect(run.pushRecent).not.toHaveBeenCalled()
    expect(existsSync(destination)).toBe(false)
  })
})

describe('VoiceScript still-image import transaction', () => {
  it('places a mono audio clip and an image overlay on independent editable lanes', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'weftcut-voicescript-still-'))
    try {
      const document = join(folder, 'VoiceScript.fcpxml')
      const narration = join(folder, 'Narration.wav')
      const image = join(folder, 'Mouth A.png')
      await writeFile(document, voiceScriptStillFixture(pathToFileURL(narration).href, pathToFileURL(image).href))
      await writeFile(narration, 'synthetic mono-audio file')
      await writeFile(image, 'synthetic still-image file')
      const probeMedia = vi.fn(async (filepath: string) => {
        const isImage = filepath === image
        const id = isImage ? '00000000-0000-0000-0000-0000000000a1' : '00000000-0000-0000-0000-0000000000a2'
        return JSON.stringify({
          ...mediaItemTemplate(id, isImage ? 'Image' : 'Audio', isImage ? null : 2_000_000),
          path_abs: filepath, file_hash_blake3: `pending-${id}`,
          metadata: {
            duration_us: isImage ? null : 2_000_000,
            video: isImage ? { width: 120, height: 130, fps_num: 0, fps_den: 0 } : null,
            audio: isImage ? null : { sample_rate: 48000, channels: 1, codec: 'pcm_s16le' },
          },
        })
      })
      const { project, report } = await prepareTimelineProject(
        document, join(folder, 'Imported project'), undefined, seededGen(),
        {
          compute: { probeMedia, hashMediaSource: async (filepath: string) => filepath === image ? 'a'.repeat(64) : 'b'.repeat(64) },
          statPath: (filepath) => existsSync(filepath) && statSync(filepath).isFile() ? { kind: 'file', readable: true } : null,
        },
        () => {},
      )
      expect(report).toMatchObject({ videoClips: 1, audioClips: 1, connectedClips: 2, durationFrames: 120 })
      const root = rootComposition(project)
      const images = root.tracks.flatMap((track) => track.layers.filter((layer) => layer.params.kind === 'ImageOverlay'))
      const audio = root.tracks.flatMap((track) => track.layers.filter((layer) => layer.params.kind === 'Audio'))
      expect(images).toHaveLength(1)
      expect(audio).toHaveLength(1)
      expect(images[0]).toMatchObject({ t_start_us: 500000, t_end_us: 1500000 })
      expect(audio[0]).toMatchObject({ t_start_us: 0, t_end_us: 2000000 })
      expect(() => validate(project)).not.toThrow()
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
