import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seededGen } from '../ids'
import { FCPXML_LIMITS, parseFcpxml } from './fcpxml'
import { listTimelineSequences, prepareTimelineProject } from './project'

const fixture = () => `<fcpxml version="1.10"><resources>
  <format id="f" width="320" height="240" frameDuration="1/30s"/>
  <asset id="a" format="f" src="${pathToFileURL(join(tmpdir(), 'Fictional Lantern.mov')).href}" hasVideo="1" duration="1s"/>
  </resources><project name="Lantern"><sequence format="f" duration="1s"><spine>
  <asset-clip ref="a" start="0s" duration="1s"/>
  </spine></sequence></project></fcpxml>`

describe('bounded untrusted FCPXML parsing', () => {
  it.each([
    ['external DTD', () => '<!DOCTYPE fcpxml SYSTEM "https://example.invalid/evil.dtd">' + fixture(), /plain.*DOCTYPE/],
    ['external entity', () => '<!DOCTYPE fcpxml [<!ENTITY x SYSTEM "file:///home/u/private">]>' + fixture(), /plain.*DOCTYPE/],
    ['entity expansion', () => '<!DOCTYPE fcpxml [<!ENTITY x "&x;&x;">]>' + fixture(), /plain.*DOCTYPE/],
    ['undefined entity', () => fixture().replace('name="Lantern"', 'name="&unknown;"'), /Malformed/],
    ['invalid encoding', () => '<?xml version="1.0" encoding="UTF-16"?>' + fixture(), /UTF-8/],
    ['invalid Unicode', () => fixture().replace('Lantern', '\ud800'), /Malformed/],
    ['NUL', () => fixture().replace('Lantern', '\0'), /Malformed/],
    ['zero denominator', () => fixture().replace('duration="1s"', 'duration="1/0s"'), /invalid|out-of-range/],
    ['negative denominator', () => fixture().replace('duration="1s"', 'duration="1/-2s"'), /non-negative rational/],
    ['huge time', () => fixture().replace('duration="1s"', 'duration="9999999999999999s"'), /out-of-range/],
    ['missing resource', () => fixture().replace('ref="a"', 'ref="missing"'), /Resource "missing"/],
    ['duplicate resource', () => fixture().replace('id="a"', 'id="f"'), /Duplicate resource/],
    ['cyclic structure', () => fixture().replace('<asset-clip ref="a"', '<ref-clip ref="a"'), /Unsupported/],
    ['relative path', () => fixture().replace(/src="[^"]+"/, 'src="../Lantern.mov"'), /absolute local file/],
    ['encoded traversal', () => fixture().replace(/src="[^"]+"/, 'src="file:///home/u/%2e%2e/Lantern.mov"'), /absolute local file/],
    ['traversal', () => fixture().replace(/src="[^"]+"/, 'src="file:///home/u/../Lantern.mov"'), /absolute local file/],
  ] as const)('refuses %s without resolving anything', (_name, input, message) => {
    expect(() => parseFcpxml(input())).toThrow(message)
  })

  it('bounds document bytes for both file and direct-parser callers', () => {
    expect(() => parseFcpxml(' '.repeat(FCPXML_LIMITS.bytes + 1))).toThrow(/16 MiB/)
  })

  it('bounds nesting before building an arbitrarily deep tree', () => {
    const nested = '<node>'.repeat(FCPXML_LIMITS.depth) + '</node>'.repeat(FCPXML_LIMITS.depth)
    expect(() => parseFcpxml('<fcpxml>' + nested + '</fcpxml>')).toThrow(/nesting is too deep/)
  })

  it('bounds repeated elements independently of input byte size', () => {
    expect(() => parseFcpxml('<fcpxml>' + '<x/>'.repeat(FCPXML_LIMITS.elements) + '</fcpxml>'))
      .toThrow(/too many elements/)
  })

  it('bounds attribute counts and values', () => {
    const attrs = Array.from({ length: FCPXML_LIMITS.attributes + 1 }, (_, i) => `a${i}="x"`).join(' ')
    expect(() => parseFcpxml(`<fcpxml ${attrs}/>`)).toThrow(/attribute limits/)
    expect(() => parseFcpxml(`<fcpxml name="${'x'.repeat(FCPXML_LIMITS.attributeLength + 1)}"/>`))
      .toThrow(/attribute limits/)
  })
})

describe('untrusted documents and bundles on disk', () => {
  const folders: string[] = []
  const deps = {
    statPath: () => ({ kind: 'file' as const, readable: true }),
    compute: { probeMedia: vi.fn(async () => { throw new Error('Unexpected media probe') }),
      hashMediaSource: vi.fn(async () => { throw new Error('Unexpected media hash') }) },
  }
  async function folder() {
    const dir = await mkdtemp(join(tmpdir(), 'weftcut-hostile-'))
    folders.push(dir)
    return dir
  }
  afterEach(async () => {
    expect(deps.compute.probeMedia).not.toHaveBeenCalled()
    expect(deps.compute.hashMediaSource).not.toHaveBeenCalled()
    for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('refuses oversized files before allocating or probing media', async () => {
    const dir = await folder(), path = join(dir, 'Oversized.fcpxml')
    await writeFile(path, '')
    await truncate(path, FCPXML_LIMITS.bytes + 1)
    await expect(listTimelineSequences(path, deps)).rejects.toThrow(/16 MiB/)
  })

  it('refuses invalid UTF-8 bytes before sequence selection', async () => {
    const path = join(await folder(), 'Invalid.fcpxml')
    await writeFile(path, Buffer.from([0xff, 0xfe, 0x00]))
    await expect(listTimelineSequences(path, deps)).rejects.toThrow(/UTF-8/)
  })

  it.skipIf(process.platform === 'win32')('refuses bundle and Info.fcpxml symlink escapes', async () => {
    const dir = await folder(), bundle = join(dir, 'Lantern.fcpxmld')
    const outside = join(dir, 'Outside.fcpxml')
    await writeFile(outside, fixture())
    await mkdir(bundle)
    await symlink(outside, join(bundle, 'Info.fcpxml'))
    await expect(prepareTimelineProject(bundle, dir, seededGen(), deps, () => {}))
      .rejects.toThrow(/regular Info.fcpxml/)
    const alias = join(dir, 'Alias.fcpxmld')
    await symlink(bundle, alias)
    await expect(listTimelineSequences(alias, deps)).rejects.toThrow(/accessible.*directory/)
  })

  it('refuses a bundle whose root Info document is missing', async () => {
    const dir = await folder(), bundle = join(dir, 'Broken.fcpxmld')
    await mkdir(join(bundle, 'Nested'), { recursive: true })
    await writeFile(join(bundle, 'Nested', 'Info.fcpxml'), fixture())
    await expect(listTimelineSequences(bundle, deps)).rejects.toThrow(/regular Info.fcpxml/)
  })
})
