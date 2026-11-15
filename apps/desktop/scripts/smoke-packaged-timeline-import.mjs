import { _electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeProcessTree, ownProcessTree } from '../e2e/lib/process-cleanup.mjs'
import { packagedApp } from './check-packaged-cli-lib.mjs'

function makeWav() {
  const bytes = Buffer.alloc(44 + 9600)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(48000, 24)
  bytes.writeUInt32LE(96000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  return bytes
}

const { executable } = packagedApp(process.platform, resolve(process.argv[2] ?? 'release'))
const folder = mkdtempSync(join(tmpdir(), 'weftcut-packaged-import-'))
const xml = join(folder, 'Storyboard.fcpxml')
const image = join(folder, 'Drawing.png')
const audio = join(folder, 'Guide.wav')
const missing = join(folder, 'Later Drawing.png')
const profile = join(folder, 'profile')

let app, tree
try {
  writeFileSync(image, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGNYa1YERwzIHACMegqpR/eOnwAAAABJRU5ErkJggg==', 'base64'))
  writeFileSync(audio, makeWav())
  writeFileSync(xml, `<fcpxml version="1.14"><resources>
    <format id="sequence" width="320" height="240" frameDuration="1/30s"/>
    <format id="image" width="4" height="2"/>
    <asset id="drawing" hasVideo="1" format="image" duration="0s" src="${pathToFileURL(image).href}"/>
    <asset id="unavailable" hasVideo="1" format="image" duration="0s" src="${pathToFileURL(missing).href}"/>
    <asset id="guide" hasAudio="1" audioChannels="1" audioRate="48000" duration="1/10s" src="${pathToFileURL(audio).href}"/>
    </resources><project name="Storyboard"><sequence format="sequence" duration="3/10s"><spine>
      <gap duration="3/10s">
        <audio ref="guide" lane="-1" offset="0s" duration="1/10s"/>
        <video ref="drawing" name="Drawing" lane="1" offset="1/10s" duration="1/10s"/>
        <video ref="unavailable" name="Later Drawing" lane="1" offset="2/10s" duration="1/10s"/>
      </gap>
    </spine></sequence></project></fcpxml>`)
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
  const linux = process.platform === 'linux' ? ['--no-sandbox', '--enable-unsafe-swiftshader'] : []
  app = await _electron.launch({
    executablePath: executable,
    args: ['--lang=en-US', `--user-data-dir=${profile}`, ...linux],
    env: { ...cleanEnv, PATH: folder, LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:en',
      LC_ALL: 'en_US.UTF-8', WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' },
    timeout: 30_000,
  })
  tree = ownProcessTree(app.process())
  await app.evaluate(({ dialog }, { xml, folder }) => {
    dialog.showOpenDialog = async (_window, options) => ({
      canceled: false, filePaths: [options?.properties?.includes('openDirectory') ? folder : xml],
    })
  }, { xml, folder })
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(15_000)
  await page.getByRole('button', { name: 'Import timeline…', exact: true }).click()
  await page.getByRole('button', { name: 'Choose FCPXML file…' }).click()
  await page.getByRole('button', { name: 'Review with a marked gap' }).click()
  const review = page.getByRole('dialog', { name: 'Review timeline import' })
  await expect(review.getByText(/Video clips 1.*Audio clips 1.*Media files 2/)).toBeVisible({ timeout: 15_000 })
  await review.getByRole('checkbox', { name: 'Import with the marked gaps shown above' }).check()
  await review.getByRole('button', { name: 'Choose project location…' }).click()
  const create = page.getByRole('dialog', { name: 'Create project from timeline' })
  await create.getByRole('button', { name: 'Choose…', exact: true }).click()
  await create.getByRole('button', { name: 'Create', exact: true }).click()
  await create.waitFor({ state: 'hidden' })

  const project = JSON.parse(readFileSync(join(folder, 'Storyboard', 'project.json'), 'utf8'))
  const sequence = Object.values(project.compositions).find(comp => comp.id !== project.root_id)
  assert.ok(sequence, 'The installed app saved a separate editable composition')
  const layers = sequence.tracks.flatMap(track => track.layers)
    .map(layer => [layer.params.kind, layer.t_start_us, layer.t_end_us])
  assert.deepEqual(layers, [['Audio', 0, 100000], ['ImageOverlay', 100000, 200000]])
  assert.deepEqual(sequence.markers.map(marker => [marker.label, marker.t_us, marker.end_t_us]),
    [['Replace media — Later Drawing', 200000, 300000]])
  assert.equal(sequence.duration_us, 300000)
  console.log('Packaged timeline import: startup review, still and audio probing, marked gap, and saved edit passed.')
} finally {
  try { if (app && tree) await closeProcessTree(tree, () => app.close()) }
  finally { rmSync(folder, { recursive: true, force: true }) }
}
