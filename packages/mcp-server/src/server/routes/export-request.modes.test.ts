/**
 * An export is held to the data dir's modes: a file nobody but its owner can
 * read, in directories nobody else can enter. Under the umask alone it lands
 * 0644 in 0755 directories, and on a host bind mount every other host user
 * can read the rendered document.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHMOD_IS_OBSERVABLE } from '../../shared/test-utils/chmod-is-observable.js'
import { writeExportAnswer } from './export-request.js'

const NOTHING_UNDRAWN = { undrawable: [], unresolvedFamilies: [] }

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

describe('the modes an export is written with', () => {
  let root: string
  let previousUmask: number

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-export-modes-'))
    // The umask the finding is about, set rather than assumed: under a 077
    // umask the modes would come out owner-only with no help from the writer.
    previousUmask = process.umask(0o022)
  })
  afterEach(async () => {
    process.umask(previousUmask)
    await rm(root, { recursive: true, force: true })
  })

  const target = (outputPath: string | undefined) => ({
    outputPath,
    layout: { exportsDir: (workspaceId: string) => join(root, 'exports', workspaceId) },
    workspaceId: 'ws-modes',
    path: 'plans/board',
    extension: 'svg',
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)('writes a default-path export owner-only', async () => {
    const { filePath: written } = await writeExportAnswer(
      '<svg/>',
      target(undefined),
      NOTHING_UNDRAWN,
    )
    expect(written.startsWith(join(root, 'exports', 'ws-modes'))).toBe(true)
    expect((await modeOf(written)) & 0o077).toBe(0)
    expect((await modeOf(dirname(written))) & 0o077).toBe(0)
    expect((await modeOf(join(root, 'exports', 'ws-modes'))) & 0o077).toBe(0)
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)('writes a caller-chosen output path owner-only', async () => {
    const outputPath = join(root, 'out', 'nested', 'board.svg')
    await writeExportAnswer('<svg/>', target(outputPath), NOTHING_UNDRAWN)
    expect((await modeOf(outputPath)) & 0o077).toBe(0)
    expect((await modeOf(dirname(outputPath))) & 0o077).toBe(0)
  })
})
