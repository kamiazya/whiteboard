import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDaemonSupportBundle } from './daemon-support-bundle.js'
import type { RunServerDoctorOutcome } from './server-doctor.js'
import type { RunServerStatusOutcome } from './server-status.js'
import { runServerSupportBundle } from './server-support-bundle.js'

let root: string

beforeEach(async () => {
  // Resolved, so a platform whose temp dir is itself reached through a symlink
  // does not turn every case into a symlink case.
  root = await realpath(await mkdtemp(join(tmpdir(), 'whiteboard-support-bundle-writer-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const FIXED_TS = '2026-05-10T00:00:00.000Z'

async function viaDaemon(outputDir: string) {
  return runDaemonSupportBundle({
    dataDir: join(root, 'daemon-data'),
    outputDir,
    now: () => FIXED_TS,
    packageVersion: '0.0.4-test',
    platform: { os: 'linux', nodeVersion: 'v22.0.0' },
  })
}

async function viaServer(outputDir: string) {
  return runServerSupportBundle({
    dataDir: join(root, 'server-data'),
    outputDir,
    now: () => FIXED_TS,
    packageVersion: '0.0.4-test',
    platform: { os: 'linux', nodeVersion: 'v22.0.0' },
    doRunStatus: async (): Promise<RunServerStatusOutcome> => ({
      result: { schemaVersion: 1, ok: false, state: 'missing', recordFresh: false },
      exitCode: 1,
    }),
    doRunDoctor: async (): Promise<RunServerDoctorOutcome> => ({
      result: { schemaVersion: 1, ok: true, status: 'ok', checks: [] },
      exitCode: 0,
    }),
    doReadRecord: () => ({ kind: 'missing' }),
  })
}

interface Refusal {
  readonly name: string
  /** Builds the layout under `root`; returns the output dir and a directory that must stay as it was. */
  readonly arrange: () => Promise<{ outputDir: string; untouched: string }>
}

const at = (...parts: string[]): string => join(root, ...parts)

const REFUSALS: readonly Refusal[] = [
  {
    name: 'an existing regular file',
    arrange: async () => {
      await writeFile(at('a-file'), 'x')
      return { outputDir: at('a-file'), untouched: root }
    },
  },
  {
    name: 'a non-empty directory',
    arrange: async () => {
      await mkdir(at('full'))
      await writeFile(at('full', 'canary.txt'), 'canary')
      return { outputDir: at('full'), untouched: at('full') }
    },
  },
  {
    name: 'a symlink to an empty directory',
    arrange: async () => {
      await mkdir(at('real'))
      await symlink(at('real'), at('link'))
      return { outputDir: at('link'), untouched: at('real') }
    },
  },
  {
    name: 'a missing directory below a symlinked parent',
    arrange: async () => {
      await mkdir(at('real'))
      await symlink(at('real'), at('link'))
      return { outputDir: at('link', 'bundle'), untouched: at('real') }
    },
  },
  {
    name: 'a missing directory two levels below a symlinked ancestor',
    arrange: async () => {
      await mkdir(at('real', 'sub'), { recursive: true })
      await symlink(at('real'), at('link'))
      return { outputDir: at('link', 'sub', 'bundle'), untouched: at('real', 'sub') }
    },
  },
  {
    name: 'a path below a regular file',
    arrange: async () => {
      await writeFile(at('a-file'), 'x')
      return { outputDir: at('a-file', 'bundle'), untouched: root }
    },
  },
]

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort()
}

describe('both support-bundle commands refuse an unusable output folder alike', () => {
  it('covers every refusal the writer can give', async () => {
    const answers = new Set<string>()
    for (const { arrange } of REFUSALS) {
      await rm(root, { recursive: true, force: true })
      await mkdir(root)
      answers.add((await viaServer((await arrange()).outputDir)).stderr)
    }
    expect(answers).toEqual(
      new Set([
        'Could not write support bundle. The output path must be a directory, and no part of it a symlink.\n',
        'Could not write support bundle. The output directory must be empty.\n',
        'Could not write support bundle.\n',
      ]),
    )
  })

  it.each(REFUSALS)('$name', async ({ arrange }) => {
    const { outputDir, untouched } = await arrange()
    const before = await listing(untouched)

    const daemon = await viaDaemon(outputDir)
    const server = await viaServer(outputDir)

    expect(daemon.exitCode).toBe(1)
    expect(daemon.stdout).toBe('')
    expect(daemon.stderr).not.toContain(root)
    expect(server).toEqual(daemon)
    expect(await listing(untouched)).toEqual(before)
  })
})

describe('both support-bundle commands write through the one writer', () => {
  it('writes each mode`s sections, then its manifest, and lists them in that order', async () => {
    const daemon = await viaDaemon(at('daemon-out'))
    const server = await viaServer(at('server-out'))

    expect(JSON.parse(daemon.stdout).files).toEqual(['status.json', 'doctor.json', 'manifest.json'])
    expect(JSON.parse(server.stdout).files).toEqual([
      'status.json',
      'doctor.json',
      'record.json',
      'manifest.json',
    ])
    expect((await readdir(at('daemon-out'))).sort()).toEqual([
      'doctor.json',
      'manifest.json',
      'status.json',
    ])
    expect((await readdir(at('server-out'))).sort()).toEqual([
      'doctor.json',
      'manifest.json',
      'record.json',
      'status.json',
    ])
    expect(await readFile(at('daemon-out', 'manifest.json'), 'utf-8')).toBe(
      '{"schemaVersion":1,"createdAt":"2026-05-10T00:00:00.000Z","packageVersion":"0.0.4-test",' +
        '"platform":{"os":"linux","nodeVersion":"v22.0.0"},"mode":"daemon",' +
        '"sections":["status.json","doctor.json"]}\n',
    )
    const manifest = await readFile(at('server-out', 'manifest.json'), 'utf-8')
    expect(manifest).toBe(
      '{"schemaVersion":1,"createdAt":"2026-05-10T00:00:00.000Z","packageVersion":"0.0.4-test",' +
        '"platform":{"os":"linux","nodeVersion":"v22.0.0"},"mode":"server-mode",' +
        '"sections":["status.json","doctor.json","record.json"]}\n',
    )
  })

  // A command that writes a file of its own has a second output-folder check
  // somewhere, or none.
  it.each([
    'daemon-support-bundle.ts',
    'server-support-bundle.ts',
  ])('%s leaves the filesystem to the writer', async (file) => {
    const source = await readFile(join(import.meta.dirname, file), 'utf-8')
    expect(source).toContain("from './support-bundle-writer.js'")
    expect(source).not.toMatch(/node:fs|inspectOutputPath/)
  })
})
