import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { invokeCmd, launchApp, rootSummary, tmpDir, waitForHook, type ProjectSummary } from './helpers/driver'

function encodeSource(media: string) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "nullsrc=s=320x240:r=30000/1001,geq=lum='if(eq(N,7),235,16)':cb=128:cr=128",
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.001',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', media,
  ], { windowsHide: true })
}

test('imports FCPXML from startup as an editable project and refuses missing media', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-fcpxml-')
  const source = join(folder, 'Glass Garden.fcpxml')
  const media = join(folder, 'Garden Take.mov')
  const destination = join(folder, 'Imported Garden')
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="a" format="f" start="3600s" duration="1001/1000s" hasVideo="1" hasAudio="1"
        audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Glass Garden">
    <sequence format="f" duration="6006/30000s" tcStart="0s" tcFormat="NDF">
      <spine>
        <asset-clip ref="a" name="Glass" start="108002002/30000s" duration="3003/30000s">
          <marker value="Cue" start="108003003/30000s" duration="1001/30000s"/>
        </asset-clip>
        <gap offset="3003/30000s" duration="1001/30000s"/>
        <asset-clip ref="a" name="Garden" offset="4004/30000s" start="108006006/30000s" duration="2002/30000s"/>
      </spine>
    </sequence>
  </project>
</fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await app.evaluate(({ dialog }, { source, destination }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    }, { source, destination })
    const importButton = page.getByRole('button', { name: 'Import timeline…' })
    await importButton.click()
    await expect(page.getByText(/Missing or unreadable original media/)).toBeVisible()
    expect(existsSync(destination)).toBe(false)
    expect(await invokeCmd(page, 'project_open_state')).toBeNull()

    encodeSource(media)

    await importButton.click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Video clips 2.*Audio clips 2.*Markers 1.*Media files 1/)).toBeVisible()
    expect(existsSync(destination)).toBe(false)
    expect(await invokeCmd(page, 'project_open_state')).toBeNull()
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(review).toHaveCount(0)
    expect(existsSync(destination)).toBe(false)

    await importButton.click()
    await expect(review).toBeVisible()
    const moved = join(folder, 'Moved Take.mov')
    renameSync(media, moved)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review.getByRole('alert')).toContainText('Original media changed or became unreadable')
    expect(existsSync(destination)).toBe(false)
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    renameSync(moved, media)

    await importButton.click()
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(importButton).toHaveCount(0)
    await waitForHook(page, 'getSelectedLayerIds')
    const imported = await rootSummary<ProjectSummary>(page)
    expect(imported).toMatchObject({ fps_num: 30000, fps_den: 1001, duration_us: 200200, layer_count: 4 })
    expect(imported.media).toHaveLength(1)
    expect(imported.links).toHaveLength(2)
    expect(imported.markers).toMatchObject([{ t_us: 33367, label: 'Cue' }])
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(133467))
    const sample = () => page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
    await expect.poll(async () => (await sample())?.r ?? 255).toBeLessThan(32)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(166833))
    await expect.poll(async () => (await sample())?.r ?? 0).toBeGreaterThan(200)
    const video = imported.tracks[0]!.layers.find((layer) => layer.params.kind === 'VideoClip')!
    await invokeCmd(page, 'update_layer', { layerId: video.id, patch: { label: 'Glass edit' } })
    const projectFile = join(destination, 'project.json')
    await expect.poll(async () => {
      await invokeCmd(page, 'project_save')
      const saved = JSON.parse(readFileSync(projectFile, 'utf8'))
      const item = saved.media_pool[imported.media[0]!.id]
      return item.path_rel ? readFileSync(item.path_abs).equals(readFileSync(media)) : false
    }, { timeout: 30_000 }).toBe(true)
    expect(readFileSync(projectFile, 'utf8')).toContain('Glass edit')
    await invokeCmd(page, 'project_open', { path: destination })
    expect(await rootSummary(page)).toMatchObject({ duration_us: 200200, layer_count: 4 })
  } finally { await app.close() }
})

test('imports CMX 3600 cuts with explicit origins and selected audio channels', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-edl-')
  const source = join(folder, 'Lantern Alley.edl')
  const media = join(folder, 'Lantern Take.mov')
  const destination = join(folder, 'Imported Lantern')
  encodeSource(media)
  writeFileSync(source, [
    'TITLE: Lantern Alley',
    'FCM: NON-DROP FRAME',
    '001 AX V C 10:00:00:02 10:00:00:05 01:00:00:00 01:00:00:03',
    '* FROM CLIP NAME: Lantern Take.mov',
    '002 BL V C 00:00:00:00 00:00:00:01 01:00:00:03 01:00:00:04',
    '003 AX AA/V C 10:00:00:06 10:00:00:08 01:00:00:04 01:00:00:06',
    '* SOURCE FILE: Lantern Take.mov',
  ].join('\n'))

  const { app, page } = await launchApp()
  try {
    await app.evaluate(({ dialog }, { source, destination, folder }) => {
      let opens = 0
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [opens++ === 0 ? source : folder] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    }, { source, destination, folder })
    await page.getByRole('button', { name: 'Import timeline…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import CMX 3600 EDL' })
    const submit = dialog.getByRole('button', { name: 'Review import', exact: true })
    await expect(submit).toBeDisabled()
    await dialog.getByRole('combobox', { name: 'Frame rate' }).click()
    await page.getByRole('option', { name: /29\.97/ }).click()
    await dialog.getByRole('textbox', { name: 'Timeline start timecode' }).fill('01:00:00:00')
    await dialog.getByRole('textbox', { name: 'Source start timecode' }).fill('10:00:00:00')
    await dialog.getByRole('button', { name: 'Choose…' }).click()
    await submit.click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('dialog', { name: 'Review timeline import' }).getByRole('button', { name: 'Import', exact: true }).click()
    await waitForHook(page, 'getSelectedLayerIds')
    const imported = await rootSummary<ProjectSummary>(page)
    expect(imported).toMatchObject({ fps_num: 30000, fps_den: 1001, duration_us: 200200, layer_count: 3 })
    expect(imported.media).toHaveLength(1)
    expect(imported.links).toHaveLength(1)
    expect(imported.tracks[0]!.layers.filter((layer) => layer.params.kind === 'Audio')).toHaveLength(1)
  } finally { await app.close() }
})

test('reviews and imports connected FCPXML video and audio lanes in stacking order', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-fcpxml-stacked-')
  const source = join(folder, 'Kite Workshop.fcpxml')
  const bed = join(folder, 'Bed.mov'), overlayA = join(folder, 'Green.mov'), overlayB = join(folder, 'Red.mov')
  const audio = join(folder, 'Bench Tone.wav')
  const destination = join(folder, 'Imported Workshop')
  for (const [color, file, frames] of [['blue', bed, 12], ['green', overlayA, 2], ['red', overlayB, 2]] as const) {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=320x240:r=30000/1001',
      '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
    ], { windowsHide: true })
  }
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:a', 'pcm_s16le', audio], { windowsHide: true })

  const movie = (id: string, file: string, duration: string, start: string = '0s') =>
    `<asset id="${id}" format="f" start="${start}" duration="${duration}" hasVideo="1">
        <media-rep kind="original-media" src="${pathToFileURL(file).href}"/>
      </asset>`
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    ${movie('bed', bed, '12012/30000s', '3s')}
    ${movie('green', overlayA, '2002/30000s')}
    ${movie('red', overlayB, '2002/30000s')}
    <asset id="tone" duration="1s" hasAudio="1" audioSources="1" audioChannels="1" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(audio).href}"/>
    </asset>
  </resources>
  <project name="Kite Workshop">
    <sequence format="f" duration="6006/30000s">
      <spine>
        <asset-clip ref="bed" name="Primary" start="3s" duration="6006/30000s">
          <asset-clip ref="red" name="Top" lane="2" offset="91001/30000s" start="0s" duration="2002/30000s"/>
          <asset-clip ref="tone" name="Tone" lane="-1" offset="91001/30000s" start="0s" duration="3003/30000s"/>
          <asset-clip ref="green" name="Middle" lane="1" offset="91001/30000s" start="0s" duration="2002/30000s"/>
        </asset-clip>
      </spine>
    </sequence>
  </project>
</fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await app.evaluate(({ dialog }, { source, destination }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    }, { source, destination })
    await page.getByRole('button', { name: 'Import timeline…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Lanes from bottom to top.*-1, 0, 1, 2/)).toBeVisible()
    await expect(review.getByText(/3 connected clips become independent clips/)).toBeVisible()
    await expect(review.getByText(/less than half a microsecond/)).toBeVisible()
    expect(existsSync(destination)).toBe(false)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await waitForHook(page, 'getSelectedLayerIds')
    const summary = await rootSummary<ProjectSummary>(page)
    expect(summary.layer_count).toBe(4)
    expect(summary.tracks.map((track) => track.layers[0]?.params.kind)).toEqual(['Audio', 'VideoClip', 'VideoClip', 'VideoClip'])
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const layers = project.compositions[project.root_id].tracks.map((track: { layers: { label: string; t_start_us: number; t_end_us: number }[] }) => track.layers[0])
    expect(layers.map((layer: { label: string }) => layer.label)).toEqual(['Tone', 'Primary', 'Middle', 'Top'])
    expect(layers[3]).toMatchObject({ t_start_us: 33367, t_end_us: 100100 })
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33367))
    await expect.poll(async () => {
      const sample = await page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(160, 120))
      return sample != null && sample.r > 150 && sample.g < 50 && sample.b < 50
    }).toBe(true)
  } finally { await app.close() }
})
