import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { invokeCmd, launchApp, rootSummary, tmpDir, waitForHook, type ProjectSummary } from './helpers/driver'

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
    const importButton = page.getByRole('button', { name: 'Import FCPXML…' })
    await importButton.click()
    await expect(page.getByText(/Missing or unreadable original media/)).toBeVisible()
    expect(existsSync(destination)).toBe(false)
    expect(await invokeCmd(page, 'project_open_state')).toBeNull()

    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "nullsrc=s=320x240:r=30000/1001,geq=lum='if(eq(N,7),235,16)':cb=128:cr=128",
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.001',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', media,
    ], { windowsHide: true })

    await importButton.click()
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
