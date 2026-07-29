// Unit coverage for tools/checks/src/verify-pack-contents.mjs, the versioned
// replacement for release.yml's former inline `node -e` "Verify pack
// contents" step. Cross-package import of the .mjs matches the established
// pattern in release-gate-matrix-schema.test.ts / ci-workflow-steps.test.ts.

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')
const MODULE_PATH = join(ROOT, 'tools/checks/src/verify-pack-contents.mjs')

type VerifyResult =
  | { ok: false; reason: string }
  | { ok: boolean; missing: string[]; forbidden: string[]; fileCount: number; sizeBytes: number }

interface MainOptions {
  argv?: string[]
  cwd?: string
  stdout?: { write: (chunk: string) => boolean }
  stderr?: { write: (chunk: string) => boolean }
  spawn?: (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => { status: number | null; error?: Error; stdout?: string }
  readStdin?: () => string
}

async function importModule() {
  const mod = await import(pathToFileURL(MODULE_PATH).href)
  return mod as {
    verifyPackContents: (doc: unknown) => VerifyResult
    extractPackJsonText: (raw: string) => string
    main: (options?: MainOptions) => number
  }
}

const VALID_ENTRY = {
  size: 1024,
  files: [
    { path: 'README.md' },
    { path: 'LICENSE' },
    { path: 'package.json' },
    { path: 'dist/server/mcp/index.js' },
    { path: 'dist/widget/canvas-viewer.html' },
  ],
}

function makeSink() {
  const chunks: string[] = []
  return {
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
    chunks,
  }
}

describe('verifyPackContents (pure core)', () => {
  it('accepts a valid pack document with all required files and nothing forbidden', async () => {
    const { verifyPackContents } = await importModule()
    const result = verifyPackContents([VALID_ENTRY]) as Extract<VerifyResult, { missing: string[] }>
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.forbidden).toEqual([])
    expect(result.fileCount).toBe(5)
    expect(result.sizeBytes).toBe(1024)
  })

  for (const required of [
    'README.md',
    'LICENSE',
    'package.json',
    'dist/server/mcp/index.js',
    'dist/widget/canvas-viewer.html',
  ]) {
    it(`flags ${required} as missing when it is absent`, async () => {
      const { verifyPackContents } = await importModule()
      const entry = {
        ...VALID_ENTRY,
        files: VALID_ENTRY.files.filter((f) => f.path !== required),
      }
      const result = verifyPackContents([entry]) as Extract<VerifyResult, { missing: string[] }>
      expect(result.ok).toBe(false)
      expect(result.missing).toEqual([required])
    })
  }

  const forbiddenCases: [string, string][] = [
    ['test .js artifact', 'dist/server/foo.test.js'],
    ['test .d.ts artifact', 'dist/server/foo.test.d.ts'],
    ['root-level _artifacts', '_artifacts/npm-sbom.cdx.json'],
    ['nested _artifacts', 'dist/_artifacts/npm-sbom.cdx.json'],
    ['.tsbuildinfo', 'dist/tsconfig.tsbuildinfo'],
    ['.DS_Store', 'dist/.DS_Store'],
  ]
  for (const [label, path] of forbiddenCases) {
    it(`flags a forbidden file: ${label}`, async () => {
      const { verifyPackContents } = await importModule()
      const entry = { ...VALID_ENTRY, files: [...VALID_ENTRY.files, { path }] }
      const result = verifyPackContents([entry]) as Extract<VerifyResult, { missing: string[] }>
      expect(result.ok).toBe(false)
      expect(result.forbidden).toEqual([path])
    })
  }

  it('does not flag .map files — the pack legitimately ships source maps', async () => {
    const { verifyPackContents } = await importModule()
    const entry = {
      ...VALID_ENTRY,
      files: [...VALID_ENTRY.files, { path: 'dist/server/index.js.map' }],
    }
    const result = verifyPackContents([entry]) as Extract<VerifyResult, { missing: string[] }>
    expect(result.ok).toBe(true)
    expect(result.forbidden).toEqual([])
  })

  it('regex fidelity: a .test.ts SOURCE file is not flagged (only shipped .test.js/.test.d.ts artifacts are)', async () => {
    const { verifyPackContents } = await importModule()
    const entry = {
      ...VALID_ENTRY,
      files: [...VALID_ENTRY.files, { path: 'src/server/foo.test.ts' }],
    }
    const result = verifyPackContents([entry]) as Extract<VerifyResult, { missing: string[] }>
    expect(result.ok).toBe(true)
    expect(result.forbidden).toEqual([])
  })

  it('regex fidelity: foo.tests.js (plural, unrelated) is not flagged', async () => {
    const { verifyPackContents } = await importModule()
    const entry = { ...VALID_ENTRY, files: [...VALID_ENTRY.files, { path: 'dist/foo.tests.js' }] }
    const result = verifyPackContents([entry]) as Extract<VerifyResult, { missing: string[] }>
    expect(result.ok).toBe(true)
    expect(result.forbidden).toEqual([])
  })

  it('rejects a non-array root', async () => {
    const { verifyPackContents } = await importModule()
    expect(verifyPackContents({ not: 'an array' })).toEqual({
      ok: false,
      reason: expect.stringContaining('array'),
    })
  })

  it('rejects an empty array', async () => {
    const { verifyPackContents } = await importModule()
    const result = verifyPackContents([]) as { ok: false; reason: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/empty/)
  })

  it('rejects an entry missing files', async () => {
    const { verifyPackContents } = await importModule()
    const result = verifyPackContents([{ size: 1 }]) as { ok: false; reason: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/files/)
  })

  it('rejects an entry whose files is not an array', async () => {
    const { verifyPackContents } = await importModule()
    const result = verifyPackContents([{ size: 1, files: 'nope' }]) as { ok: false; reason: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/files/)
  })

  it('rejects a file entry without a string path', async () => {
    const { verifyPackContents } = await importModule()
    const entry = { ...VALID_ENTRY, files: [...VALID_ENTRY.files, { notPath: 'x' }] }
    const result = verifyPackContents([entry]) as { ok: false; reason: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/path/)
  })

  it('rejects a missing size', async () => {
    const { verifyPackContents } = await importModule()
    const { size: _size, ...rest } = VALID_ENTRY
    const result = verifyPackContents([rest]) as { ok: false; reason: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/size/)
  })

  it('rejects a non-finite size', async () => {
    const { verifyPackContents } = await importModule()
    const entry = { ...VALID_ENTRY, size: Number.POSITIVE_INFINITY }
    const result = verifyPackContents([entry]) as { ok: false; reason: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/size/)
  })

  it('rejects a negative size', async () => {
    const { verifyPackContents } = await importModule()
    const entry = { ...VALID_ENTRY, size: -1 }
    const result = verifyPackContents([entry]) as { ok: false; reason: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/size/)
  })
})

describe('extractPackJsonText', () => {
  // `npm pack --dry-run --json` pretty-prints its array with the top-level
  // `[` alone on its own line — real output confirmed by running the command
  // locally. That is the anchor extractPackJsonText looks for, rather than a
  // global first-`[`/last-`]` scan.
  it('extracts the JSON array even with prepack lifecycle noise before it', async () => {
    const { extractPackJsonText } = await importModule()
    const raw =
      'prepack gate: dist/web-app/index.html present — OK\n[\n  {"size":1,"files":[]}\n]\n'
    expect(JSON.parse(extractPackJsonText(raw))).toEqual([{ size: 1, files: [] }])
  })

  it('extracts the JSON array when prelude noise itself contains brackets', async () => {
    const { extractPackJsonText } = await importModule()
    const raw =
      '[warn] prepack gate: skipped optional check [dist/web-app/index.html]\n' +
      '[\n  {"size":1,"files":[]}\n]\n'
    expect(JSON.parse(extractPackJsonText(raw))).toEqual([{ size: 1, files: [] }])
  })

  it('throws when no JSON array is present', async () => {
    const { extractPackJsonText } = await importModule()
    expect(() => extractPackJsonText('no json here')).toThrow()
  })

  it('extracts the JSON array when trailing output follows it (post-pack script logging)', async () => {
    const { extractPackJsonText } = await importModule()
    const raw = '[\n  {"size":1,"files":[]}\n]\npostpack: cleanup complete\n'
    expect(JSON.parse(extractPackJsonText(raw))).toEqual([{ size: 1, files: [] }])
  })

  it('extracts the JSON array when a file path inside it contains bracket characters', async () => {
    const { extractPackJsonText } = await importModule()
    const raw = '[\n  {"size":1,"files":[{"path":"dist/[locale]/page.js"}]}\n]\ntrailing noise\n'
    expect(JSON.parse(extractPackJsonText(raw))).toEqual([
      { size: 1, files: [{ path: 'dist/[locale]/page.js' }] },
    ])
  })
})

describe('main() CLI', () => {
  it('--stdin mode reads the document from stdin instead of spawning npm', async () => {
    const { main } = await importModule()
    const stdout = makeSink()
    const stderr = makeSink()
    const spawn = () => {
      throw new Error('spawn must not be called in --stdin mode')
    }
    const exitCode = main({
      argv: ['--stdin'],
      readStdin: () => JSON.stringify([VALID_ENTRY]),
      stdout,
      stderr,
      spawn,
    })
    expect(exitCode).toBe(0)
    expect(stdout.chunks.join('')).toMatch(/OK/)
  })

  it('default mode self-spawns `npm pack --dry-run --json` in cwd', async () => {
    const { main } = await importModule()
    const stdout = makeSink()
    const stderr = makeSink()
    let spawnedWith: { cmd: string; args: string[]; opts: Record<string, unknown> } | null = null
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnedWith = { cmd, args, opts }
      return { status: 0, stdout: JSON.stringify([VALID_ENTRY]) }
    }
    const exitCode = main({ cwd: '/pkg/root', stdout, stderr, spawn })
    expect(exitCode).toBe(0)
    expect(spawnedWith).toEqual({
      cmd: 'npm',
      args: ['pack', '--dry-run', '--json'],
      opts: expect.objectContaining({ cwd: '/pkg/root' }),
    })
  })

  it('spawns npm.cmd (not npm) on win32, where the bare npm binary is not on PATH', async () => {
    const { main } = await importModule()
    const stdout = makeSink()
    const stderr = makeSink()
    let spawnedCmd: string | null = null
    const spawn = (cmd: string) => {
      spawnedCmd = cmd
      return { status: 0, stdout: JSON.stringify([VALID_ENTRY]) }
    }
    const exitCode = main({ platform: 'win32', stdout, stderr, spawn })
    expect(exitCode).toBe(0)
    expect(spawnedCmd).toBe('npm.cmd')
  })

  it('fails loudly when the npm spawn itself errors', async () => {
    const { main } = await importModule()
    const stdout = makeSink()
    const stderr = makeSink()
    const spawn = () => ({ status: null, error: new Error('ENOENT') })
    const exitCode = main({ stdout, stderr, spawn })
    expect(exitCode).not.toBe(0)
    expect(stderr.chunks.join('')).toMatch(/ENOENT/)
  })

  it('fails loudly when npm pack exits non-zero', async () => {
    const { main } = await importModule()
    const stdout = makeSink()
    const stderr = makeSink()
    const spawn = () => ({ status: 1, stdout: '' })
    const exitCode = main({ stdout, stderr, spawn })
    expect(exitCode).not.toBe(0)
    expect(stderr.chunks.join('')).toMatch(/status 1|exit/i)
  })

  it('fails loudly when stdout is not parseable as JSON', async () => {
    const { main } = await importModule()
    const stdout = makeSink()
    const stderr = makeSink()
    const spawn = () => ({ status: 0, stdout: 'not json at all' })
    const exitCode = main({ stdout, stderr, spawn })
    expect(exitCode).not.toBe(0)
    expect(stderr.chunks.length).toBeGreaterThan(0)
  })

  it('fails loudly and reports missing/forbidden files on a content violation', async () => {
    const { main } = await importModule()
    const stdout = makeSink()
    const stderr = makeSink()
    const badEntry = {
      size: 1,
      files: [{ path: 'README.md' }, { path: 'dist/foo.test.js' }],
    }
    const spawn = () => ({ status: 0, stdout: JSON.stringify([badEntry]) })
    const exitCode = main({ stdout, stderr, spawn })
    expect(exitCode).not.toBe(0)
    const errText = stderr.chunks.join('')
    expect(errText).toMatch(/LICENSE/)
    expect(errText).toMatch(/foo\.test\.js/)
  })

  it('writes success summary (file count + size) to stdout, not stderr', async () => {
    const { main } = await importModule()
    const stdout = makeSink()
    const stderr = makeSink()
    const spawn = () => ({ status: 0, stdout: JSON.stringify([VALID_ENTRY]) })
    const exitCode = main({ stdout, stderr, spawn })
    expect(exitCode).toBe(0)
    expect(stderr.chunks).toEqual([])
    expect(stdout.chunks.join('')).toMatch(/\d+ files/)
  })
})
