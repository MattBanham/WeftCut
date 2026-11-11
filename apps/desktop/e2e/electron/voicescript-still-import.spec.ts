import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { launchApp, rootSummary, tmpDir, waitForHook, type ProjectSummary } from './helpers/driver'

test('imports VoiceScript-style 48 kHz mono audio and zero-duration PNG visemes as image overlays', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-voicescript-stills-')
  const source = join(folder, 'VoiceScript.fcpxml')
  const audio = join(folder, 'Narration.wav')
  const png = join(folder, 'Mouth.png')
  const destination = join(folder, 'Imported VoiceScript')

  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
    '-ac', '1', '-c:a', 'pcm_s16le', audio,
  ], { windowsHide: true })
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=red:size=120x130:rate=1', '-frames:v', '1', '-update', '1', png,
  ], { windowsHide: true })

  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1/60s" width="320" height="240"/>
    <format id="still" name="FFVideoFormatRateUndefined" width="120" height="130"/>
    <asset id="voice" name="Narration.wav" start="0s" duration="2s" hasAudio="1" audioSources="1" audioChannels="1">
      <media-rep kind="original-media" src="${pathToFileURL(audio).href}"/>
    </asset>
    <asset id="mouth" name="Mouth.png" start="0s" duration="0s" hasVideo="1" videoSources="1" format="still">
      <media-rep kind="original-media" src="${pathToFileURL(png).href}"/>
    </asset>
  </resources>
  <library><event name="VoiceScript"><project name="VoiceScript test">
    <sequence format="f" duration="120/60s" tcStart="0s" tcFormat="NDF" audioLayout="mono" audioRate="48k">
      <spine><gap offset="0s" start="0s" duration="120/60s">
        <asset-clip ref="voice" lane="-1" offset="0s" start="0s" duration="120/60s" audioRole="dialogue"/>
        <video ref="mouth" lane="1" name="A" offset="30/60s" start="0s" duration="60/60s"/>
      </gap></spine>
    </sequence>
  </project></event></library>
</fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await page.getByRole('button', { name: 'Import timeline…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Video clips 1.*Audio clips 1.*Media files 2/)).toBeVisible()
    expect(existsSync(destination)).toBe(false)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await waitForHook(page, 'getSelectedLayerIds')
    const imported = await rootSummary<ProjectSummary>(page)
    expect(imported).toMatchObject({ fps_num: 60, fps_den: 1, duration_us: 2_000_000, layer_count: 2 })
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const root = project.compositions[project.root_id]
    const layers = root.tracks.flatMap((track: { layers: { params: { kind: string }; t_start_us: number; t_end_us: number }[] }) => track.layers)
    expect(layers.map((layer: { params: { kind: string } }) => layer.params.kind).sort()).toEqual(['Audio', 'ImageOverlay'])
    expect(layers.find((layer: { params: { kind: string } }) => layer.params.kind === 'ImageOverlay'))
      .toMatchObject({ t_start_us: 500000, t_end_us: 1500000 })
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(700000))
    await expect.poll(async () => {
      const pixel = await page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
      return pixel != null && pixel.r > 150 && pixel.g < 50 && pixel.b < 50
    }).toBe(true)
  } finally { await app.close() }
})
