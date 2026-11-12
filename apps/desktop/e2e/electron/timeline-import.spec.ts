import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { invokeCmd, launchApp, newProject, rootSummary, tmpDir, waitForHook, type ProjectSummary, type ProjectSummaryWire } from './helpers/driver'

function encodeSource(media: string) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "nullsrc=s=320x240:r=30000/1001,geq=lum='if(eq(N,7),235,16)':cb=128:cr=128",
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.001',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', media,
  ], { windowsHide: true })
}


async function beginImport(page: Page, kind: "file" | "bundle" = "file") {
  await page.locator('.menu-trigger').filter({ hasText: /^File$/ }).click()
  await page.getByRole('menuitem', { name: 'Import FCPXML…' }).click()
  await page.getByRole("button", { name: "Choose FCPXML " + kind + "…" }).click()
}

async function importedSummary(page: Page): Promise<ProjectSummary> {
  const project = await invokeCmd<ProjectSummaryWire>(page, 'project_summary')
  const imported = Object.values(project.compositions).filter(c => c.id !== project.root_id)
  expect(imported).toHaveLength(1)
  const composition = imported[0]!
  return { ...project, ...composition,
    layer_count: composition.tracks.reduce((count, track) => count + track.layers.length, 0) }
}

function importedComposition(project: any): any {
  const imported = Object.values(project.compositions).filter((c: any) => c.id !== project.root_id)
  expect(imported).toHaveLength(1)
  return imported[0]
}

test('imports an editable FCPXML composition and refuses missing or changed media', async () => {
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
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, { source, destination }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    }, { source, destination })
    await beginImport(page)
    await expect(page.getByText(/Missing or unreadable original media/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    expect(await invokeCmd(page, 'project_open_state')).not.toBeNull()

    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    encodeSource(media)

    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Video clips 2.*Audio clips 2.*Markers 1.*Media files 1/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    expect(await invokeCmd(page, 'project_open_state')).not.toBeNull()
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(review).toHaveCount(0)
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)

    await beginImport(page)
    await expect(review).toBeVisible()
    const moved = join(folder, 'Moved Take.mov')
    renameSync(media, moved)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review.getByRole('alert')).toContainText('Original media changed or became unreadable')
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    renameSync(moved, media)

    await beginImport(page)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await waitForHook(page, 'getSelectedLayerIds')
    const imported = await importedSummary(page)
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
    expect(await importedSummary(page)).toMatchObject({ duration_us: 200200, layer_count: 4 })
  } finally { await app.close() }
})

test('conforms 25 fps 640×360 camera footage into a 30 fps 320×240 edit with correct preview fit', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-mixed-camera-')
  const source = join(folder, 'Camera Cut.fcpxml')
  const media = join(folder, 'Camera.mov')
  const destination = join(folder, 'Imported Camera Cut')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=25',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', media,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml><fcpxml version="1.10">
  <resources>
    <format id="seq" frameDuration="1/30s" width="320" height="240"/>
    <format id="camera" frameDuration="1/25s" width="640" height="360"/>
    <asset id="take" format="camera" duration="1s" hasVideo="1" hasAudio="0">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Camera Cut">
    <sequence format="seq" duration="3/30s">
      <spine><asset-clip ref="take" start="1/25s" duration="3/30s"/></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Video clips using source-timestamp frame-rate conform: 1')
    await expect(review).toContainText('Video clips with source-size or spatial-conform adjustments: 1')
    await expect(review).toContainText('Camera.mov')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    const summary = await importedSummary(page)
    expect(summary).toMatchObject({ fps_num: 30, fps_den: 1, duration_us: 100000, layer_count: 1 })
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const clip = importedComposition(saved).tracks.flatMap(
      (t: { layers: unknown[] }) => t.layers,
    ).find((layer: any) => layer.params.kind === 'VideoClip')
    expect(clip.params.transform).toMatchObject({
      position: { x: { mode: 'Static', value: 160 }, y: { mode: 'Static', value: 120 } },
      scale_x: { mode: 'Static', value: 0.5 },
      scale_y: { mode: 'Static', value: 0.5 },
    })
    expect(clip.params.src_in_us).toBe(40000)
    expect(clip.params.src_out_us).toBe(140000)
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33333))
    const sample = (x: number, y: number) =>
      page.evaluate(({ x, y }) => (window as any).__weftcutTest.weftcutSampleComposite(x, y), { x, y })
    await expect.poll(async () => (await sample(160, 120))?.r ?? 0).toBeGreaterThan(180)
    await expect.poll(async () => (await sample(160, 10))?.r ?? 255).toBeLessThan(80)
  } finally { await app.close() }
})

test('selects one of multiple FCPXML project sequences and leaves the others unimported', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-multi-sequence-')
  const source = join(folder, 'Multiple.fcpxml')
  const media = join(folder, 'Shared.mov')
  const destination = join(folder, 'Chosen Sequence')
  encodeSource(media)
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1"
      audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <library>
    <event name="Drafts">
      <project name="Unusable Draft">
        <sequence format="f" duration="3003/30000s">
          <spine><transition name="Complex Fade" duration="3003/30000s"/></spine>
        </sequence>
      </project>
    </event>
    <event name="Approved">
      <project name="Final Export">
        <sequence format="f" duration="3003/30000s">
          <spine><asset-clip ref="a" duration="3003/30000s" start="0s"/></spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const picker = page.getByRole('dialog', { name: 'Choose a timeline to import' })
    await expect(picker).toContainText('2 timelines')
    await picker.getByRole('combobox', { name: 'Source timeline' }).click()
    await page.getByRole('option', { name: /Approved \/ Final Export/ }).click()
    await picker.getByRole('button', { name: 'Review selected timeline' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Final Export')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await expect.poll(async () => (await importedSummary(page)).layer_count).toBe(2)
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    expect(importedComposition(saved).label).toBe('Final Export')
  } finally { await app.close() }
})

test('fits non-square pixel aspect footage while preserving display geometry', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-pixel-aspect-')
  const source = join(folder, 'NonSquare.fcpxml')
  const media = join(folder, 'NonSquare.mov')
  const destination = join(folder, 'Imported NonSquare')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=red:s=640x360:r=25', '-vf', 'setsar=8/9',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', media,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml><fcpxml version="1.10">
  <resources>
    <format id="seq" frameDuration="1/30s" width="320" height="240"/>
    <format id="camera" frameDuration="1/25s" width="640" height="360" paspH="8" paspV="9"/>
    <asset id="take" format="camera" duration="1s" hasVideo="1" hasAudio="0">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="NonSquare">
    <sequence format="seq" duration="3/30s">
      <spine><asset-clip ref="take" start="1/25s" duration="3/30s"/></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('SAR 8:9')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const clip = importedComposition(saved).tracks.flatMap(
      (t: { layers: unknown[] }) => t.layers,
    ).find((layer: any) => layer.params.kind === 'VideoClip')
    expect(clip.params.transform).toMatchObject({
      scale_x: { mode: 'Static', value: 0.5 },
      scale_y: { mode: 'Static', value: 0.5625 },
    })
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33333))
    const sample = (x: number, y: number) =>
      page.evaluate(({ x, y }) => (window as any).__weftcutTest.weftcutSampleComposite(x, y), { x, y })
    await expect.poll(async () => (await sample(160, 24))?.r ?? 0).toBeGreaterThan(180)
    await expect.poll(async () => (await sample(160, 10))?.r ?? 255).toBeLessThan(80)
  } finally { await app.close() }
})

test('keeps FCPXML fill conform and static audio gain as editable layer settings', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-adjustment-import-')
  const source = join(folder, 'Adjusted.fcpxml')
  const media = join(folder, 'Adjusted.mov')
  const destination = join(folder, 'Imported Adjusted')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=red:s=640x360:r=25', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', media,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml><fcpxml version="1.10">
  <resources>
    <format id="seq" frameDuration="1/30s" width="320" height="240"/>
    <format id="camera" frameDuration="1/25s" width="640" height="360"/>
    <asset id="take" format="camera" duration="1s" hasVideo="1" hasAudio="1"
      audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Adjusted">
    <sequence format="seq" duration="3/30s">
      <spine><asset-clip ref="take" start="1/25s" duration="3/30s">
        <adjust-conform type="fill"/><adjust-volume amount="-6dB"/>
      </asset-clip></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Spatial conform: fill the canvas')
    await expect(review).toContainText('Static clip gain: -6dB')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const clips = importedComposition(saved).tracks.flatMap((t: { layers: unknown[] }) => t.layers)
    const video = clips.find((layer: any) => layer.params.kind === 'VideoClip')
    const audio = clips.find((layer: any) => layer.params.kind === 'Audio')
    expect(video.params.transform.scale_x.value).toBeCloseTo(2 / 3, 5)
    expect(video.params.transform.scale_y.value).toBeCloseTo(2 / 3, 5)
    expect(audio.params.gain_db).toMatchObject({ mode: 'Static', value: -6 })
  } finally { await app.close() }
})

test('renders FCPXML static position/scale and normal opacity without baking media', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-transform-import-')
  const source = join(folder, 'Moved Clip.fcpxml')
  const media = join(folder, 'Red Card.mov')
  const destination = join(folder, 'Imported Moved')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=red:s=320x240:r=30000/1001',
    '-t', '1.001', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', media,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml><fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="take" format="f" duration="1001/1000s" hasVideo="1" hasAudio="0">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Moved Clip">
    <sequence format="f" duration="3003/30000s">
      <spine><asset-clip ref="take" start="0s" duration="3003/30000s">
        <adjust-transform position="25 0" scale="0.5 0.5" rotation="0"/>
        <adjust-blend amount="0.5" mode="0"/>
      </asset-clip></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Static position/scale/rotation')
    await expect(review).toContainText('Static opacity: 0.5')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await invokeCmd(page, 'project_save')
    const saved = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const clip = importedComposition(saved).tracks.flatMap((t: { layers: unknown[] }) => t.layers)
      .find((layer: any) => layer.params.kind === 'VideoClip')
    expect(clip.params).toMatchObject({
      opacity: { mode: 'Static', value: 0.5 },
      transform: {
        position: { x: { mode: 'Static', value: 220 }, y: { mode: 'Static', value: 120 } },
        scale_x: { mode: 'Static', value: 0.5 },
        scale_y: { mode: 'Static', value: 0.5 },
      },
    })
    await waitForHook(page, 'weftcutSampleComposite')
    await page.waitForFunction(() => (window as any).__weftcutTest.previewResourceProbe?.() != null)
    await page.evaluate(() => (window as any).__weftcutTest.transportSeekUs(33333))
    const sample = (x: number, y: number) =>
      page.evaluate(({ x, y }) => (window as any).__weftcutTest.weftcutSampleComposite(x, y), { x, y })
    await expect.poll(async () => (await sample(220, 120))?.r ?? 0).toBeGreaterThan(70)
    await expect.poll(async () => (await sample(220, 120))?.a ?? 0).toBeGreaterThan(110)
    await expect.poll(async () => (await sample(220, 120))?.a ?? 255).toBeLessThan(145)
    await expect.poll(async () => (await sample(60, 120))?.a ?? 255).toBeLessThan(5)
  } finally { await app.close() }
})

test('imports a Final Cut bundle with Info.fcpxml and reports its source', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-bundle-')
  const bundle = join(folder, 'Fictional Scene.fcpxmld')
  const media = join(folder, 'Scene.mov')
  const destination = join(folder, 'Imported Scene')
  mkdirSync(bundle)
  encodeSource(media)
  writeFileSync(join(bundle, 'Info.fcpxml'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <import-options><option key="library location" value="file:///fictional/Library.fcpbundle"/></import-options>
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1"
      audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Fictional Scene">
    <sequence format="f" duration="3003/30000s">
      <spine><asset-clip ref="a" duration="3003/30000s" start="0s"/></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, args) => {
      dialog.showOpenDialog = async (_window, options) => {
        const expected = process.platform === 'darwin' ? ['openDirectory', 'treatPackageAsDirectory'] : ['openDirectory']
        if (JSON.stringify(options.properties) !== JSON.stringify(expected)) throw new Error('Wrong picker for a bundle')
        return { canceled: false, filePaths: [args.bundle] }
      }
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: args.destination })
    }, { bundle, destination })
    await beginImport(page, "bundle")
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Source: FCPXML bundle')
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await expect.poll(async () => (await importedSummary(page)).layer_count).toBe(2)
    expect(existsSync(join(destination, 'project.json'))).toBe(true)
  } finally { await app.close() }
})

test('relinks missing FCPXML media only after explicit folder selection and review', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-relink-flow-')
  const source = join(folder, 'Offline.fcpxml')
  const lost = join(folder, 'Old Disk', 'Scene.mov')
  const relocatedFolder = join(folder, 'Found Media')
  const actual = join(relocatedFolder, 'Scene.mov')
  const destination = join(folder, 'Relinked Edit')
  mkdirSync(relocatedFolder)
  encodeSource(actual)
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1"
      audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(lost).href}"/>
    </asset>
  </resources>
  <project name="Offline">
    <sequence format="f" duration="3003/30000s">
      <spine><asset-clip ref="a" duration="3003/30000s" start="0s"/></spine>
    </sequence>
  </project>
</fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async (_window, options) => {
        const pickingDirectory = options.properties?.length === 1 &&
          options.properties.includes('openDirectory')
        return { canceled: false, filePaths: [pickingDirectory ? input.relocatedFolder : input.source] }
      }
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, relocatedFolder, destination })
    await beginImport(page)
    await expect(page.getByText(/Missing or unreadable original media/)).toBeVisible()
    await page.getByRole('button', { name: 'Find original media in a folder…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Check media replacements')
    await expect(review).toContainText(lost)
    await expect(review).toContainText(actual)
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await expect.poll(async () => (await importedSummary(page)).layer_count).toBe(2)
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const record = Object.values(project.media_pool)[0] as { path_abs: string }
    expect(readFileSync(record.path_abs)).toEqual(readFileSync(actual))
  } finally { await app.close() }
})

test('imports into the current project as one undoable Group without replacing its edit', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-current-import-')
  const source = join(folder, 'Short Scene.fcpxml')
  const media = join(folder, 'Scene.mov')
  const original = join(folder, 'Original')
  encodeSource(media)
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1001/30000s" width="320" height="240"/>
    <asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1"
      audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${pathToFileURL(media).href}"/>
    </asset>
  </resources>
  <project name="Short Scene">
    <sequence format="f" duration="3003/30000s">
      <spine><asset-clip ref="a" duration="3003/30000s" start="0s"/></spine>
    </sequence>
  </project>
</fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: folder, name: 'Original',
      canvas: { width: 1920, height: 1080, fpsNum: 30000, fpsDen: 1001 },
    })
    const originalFile = join(original, 'project.json')
    const before = JSON.parse(readFileSync(originalFile, 'utf8'))
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      // In-project importing MUST NOT ask for a project destination.
      dialog.showSaveDialog = async () => { throw new Error('Unexpected Save As dialog') }
    }, { source })

    await page.locator('.menu-trigger').filter({ hasText: /^File$/ }).click()
    await page.getByRole('menuitem', { name: 'Import FCPXML…' }).click()
    await page.getByRole('button', { name: 'Choose FCPXML file…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review).toContainText('Compare project settings')
    await expect(review.getByText(/1920 × 1080/)).toBeVisible()
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(review).toHaveCount(0)
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)

    await page.locator('.menu-trigger').filter({ hasText: /^File$/ }).click()
    await page.getByRole('menuitem', { name: 'Import FCPXML…' }).click()
    await page.getByRole('button', { name: 'Choose FCPXML file…' }).click()
    await expect(review).toBeVisible()
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    // The project summary counts nested clips as well as the Group layer.
    await expect.poll(async () => (await rootSummary<ProjectSummary>(page)).layer_count).toBe(3)

    await invokeCmd(page, 'project_save')
    const after = JSON.parse(readFileSync(originalFile, 'utf8'))
    expect(after.project_id).toBe(before.project_id)
    expect(after.root_id).toBe(before.root_id)
    expect(Object.keys(after.compositions)).toHaveLength(2)
    const root = after.compositions[after.root_id]
    const groups = root.tracks.flatMap((track: { layers: { params: { kind: string } }[] }) => track.layers)
      .filter((layer: { params: { kind: string } }) => layer.params.kind === 'CompositionRef')
    expect(groups).toHaveLength(1)
    expect(Object.keys(after.media_pool)).toHaveLength(1)
    // The in-project media source is copied into the existing workspace,
    // not left as a dependency on a temporary external import folder.
    await expect.poll(async () => {
      await invokeCmd(page, 'project_save')
      const saved = JSON.parse(readFileSync(originalFile, 'utf8'))
      const item = Object.values(saved.media_pool)[0] as { path_rel: string | null; path_abs: string }
      return item.path_rel !== null && existsSync(item.path_abs) &&
        readFileSync(item.path_abs).equals(readFileSync(media))
    }, { timeout: 30_000 }).toBe(true)
    await invokeCmd(page, 'project_undo')
    await expect.poll(async () => (await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    expect((await invokeCmd(page, 'project_open_state'))).not.toBeNull()
  } finally { await app.close() }
})

test('refuses current-project FPS conflict before import', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-conflict-import-')
  const media = join(folder, 'Source.mov')
  const xml = join(folder, 'Conflict.fcpxml')
  encodeSource(media)
  writeFileSync(xml, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml><fcpxml version="1.10">
<resources><format id="f" frameDuration="1001/30000s" width="320" height="240"/>
<asset id="a" format="f" duration="1001/1000s" hasVideo="1" hasAudio="1"
audioSources="1" audioChannels="2" audioRate="48000">
<media-rep kind="original-media" src="${pathToFileURL(media).href}"/></asset></resources>
<project name="Conflict"><sequence format="f" duration="3003/30000s">
<spine><asset-clip ref="a" duration="3003/30000s" start="0s"/></spine>
</sequence></project></fcpxml>`)
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: folder, name: 'Original',
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 },
    })
    const state = await invokeCmd(page, 'project_open_state')
    const otherDestination = join(folder, 'Imported as New')
    await app.evaluate(({ dialog }, { path, otherDestination }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: otherDestination })
    }, { path: xml, otherDestination })
    await page.locator('.menu-trigger').filter({ hasText: /^File$/ }).click()
    await page.getByRole('menuitem', { name: 'Import FCPXML…' }).click()
    await page.getByRole('button', { name: 'Choose FCPXML file…' }).click()
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/These frame rates differ/)).toBeVisible()
    await expect(review.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await invokeCmd(page, 'project_open_state')).toEqual(state)
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
  } finally { await app.close() }
})

test('discloses 96 kHz surround resampling and stereo downmix before import', async () => {
  test.setTimeout(90_000)
  const folder = tmpDir('weftcut-surround-import-')
  const source = join(folder, 'Surround Edit.fcpxml')
  const audio = join(folder, 'Six Channel.wav')
  const destination = join(folder, 'Imported Surround')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=96000', '-t', '1',
    '-ac', '6', '-c:a', 'pcm_s16le', audio,
  ], { windowsHide: true })
  writeFileSync(source, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="f" frameDuration="1/30s" width="320" height="240"/>
    <asset id="tone" hasAudio="1" audioSources="1" audioChannels="6" audioRate="96000"
      start="0s" duration="1s">
      <media-rep kind="original-media" src="${pathToFileURL(audio).href}"/>
    </asset>
  </resources>
  <project name="Surround Edit">
    <sequence format="f" duration="1s" audioLayout="surround" audioRate="96k">
      <spine><gap offset="0s" duration="1s">
        <asset-clip ref="tone" lane="-1" offset="0s" start="0s" duration="1s"/>
      </gap></spine>
    </sequence>
  </project>
</fcpxml>`)

  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30, fpsDen: 1 } })
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Audio clips requiring 48 kHz resampling: 1/)).toBeVisible()
    await expect(review.getByText(/Audio clips requiring stereo downmixing: 1/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect.poll(async () => (await importedSummary(page)).layer_count).toBe(1)
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const pool = Object.values(project.media_pool) as { metadata: { audio: { sample_rate: number; channels: number } } }[]
    expect(pool).toHaveLength(1)
    expect(pool[0]?.metadata.audio).toMatchObject({ sample_rate: 96000, channels: 6 })
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
    await newProject(page, { parentFolder: dirname(destination), name: basename(destination),
      canvas: { width: 320, height: 240, fpsNum: 30000, fpsDen: 1001 } })
    await app.evaluate(({ dialog }, { source, destination }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
    }, { source, destination })
    await beginImport(page)
    const review = page.getByRole('dialog', { name: 'Review timeline import' })
    await expect(review.getByText(/Lanes from bottom to top.*-1, 0, 1, 2/)).toBeVisible()
    await expect(review.getByText(/3 connected clips become independent clips/)).toBeVisible()
    await expect(review.getByText(/less than half a microsecond/)).toBeVisible()
    expect((await rootSummary<ProjectSummary>(page)).layer_count).toBe(0)
    await review.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(review).toHaveCount(0)
    await waitForHook(page, 'getSelectedLayerIds')
    const summary = await importedSummary(page)
    expect(summary.layer_count).toBe(4)
    expect(summary.tracks.map((track) => track.layers[0]?.params.kind)).toEqual(['Audio', 'VideoClip', 'VideoClip', 'VideoClip'])
    await invokeCmd(page, 'project_save')
    const project = JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8'))
    const layers = importedComposition(project).tracks.map((track: { layers: { label: string; t_start_us: number; t_end_us: number }[] }) => track.layers[0])
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
