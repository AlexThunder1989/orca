import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { LAYOUT_OWNER_MARKER_FILENAME, assertNotLayoutOwnerBuild, layoutOwnerDefine } =
  createRequire(import.meta.url)('../layout-owner-build.cjs')

const scratch = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('layout-owner build switch', () => {
  it('compiles the dark path in only when ORCA_LAYOUT_OWNER=main asks', () => {
    expect(layoutOwnerDefine({ ORCA_LAYOUT_OWNER: 'main' })).toBe('"main"')
    expect(layoutOwnerDefine({ ORCA_LAYOUT_OWNER: 'window' })).toBe('"window"')
    expect(layoutOwnerDefine({})).toBe('"window"')
  })

  it('refuses the switch at packaging time, and any output a dark build marked', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'orca-layout-owner-clean-'))
    const dark = await mkdtemp(join(tmpdir(), 'orca-layout-owner-dark-'))
    scratch.push(clean, dark)
    await writeFile(join(dark, LAYOUT_OWNER_MARKER_FILENAME), 'dark\n')

    expect(() => assertNotLayoutOwnerBuild([clean], {})).not.toThrow()
    expect(() => assertNotLayoutOwnerBuild([clean], { ORCA_LAYOUT_OWNER: 'main' })).toThrow(
      'ORCA_LAYOUT_OWNER=main'
    )
    expect(() => assertNotLayoutOwnerBuild([clean, dark], {})).toThrow(dark)
  })
})
