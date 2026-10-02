import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureStdio } from '../shared/test-utils/capture-stdio.js'
import { runDaemonSupportBundle } from './daemon-support-bundle.js'
import { main } from './dispatcher.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whiteboard-daemon-support-bundle-cli-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const FIXED_TS = '2026-05-10T00:00:00.000Z'

describe('runDaemonSupportBundle helper', () => {
  it('happy path: missing daemon record + missing output dir → exit 0, JSON success result, four files on disk', async () => {
    const dataDir = join(root, 'data')
    const outputDir = join(root, 'bundle-out')

    const outcome = await runDaemonSupportBundle({
      dataDir,
      outputDir,
      now: () => FIXED_TS,
      packageVersion: '0.0.4-test',
      platform: { os: 'darwin', nodeVersion: 'v22.0.0' },
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stderr).toBe('')
    expect(outcome.stdout.endsWith('\n')).toBe(true)
    const result = JSON.parse(outcome.stdout.trim())
    expect(result.ok).toBe(true)
    expect(result.outputDir).toBe(outputDir)
    expect(result.files).toEqual(['status.json', 'doctor.json', 'manifest.json'])

    const onDisk = (await readdir(outputDir)).sort()
    expect(onDisk).toEqual(['doctor.json', 'manifest.json', 'status.json'])

    const manifest = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf-8'))
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.packageVersion).toBe('0.0.4-test')
    expect(manifest.platform).toEqual({ os: 'darwin', nodeVersion: 'v22.0.0' })
    expect(manifest.createdAt).toBe(FIXED_TS)
    expect(manifest.sections).toEqual(['status.json', 'doctor.json'])
  })

  it('on-disk bundle inherits redaction: stdout + every file is free of token / Authorization / Bearer / common path / stack frames', async () => {
    const dataDir = join(root, 'data-leaky')
    const outputDir = join(root, 'bundle-leaky')
    // Seed a deliberately leaky daemon.json — the status / doctor
    // helpers must funnel its `token` value through the redactor +
    // formatter funnel. Even with the token literal exposed on disk
    // here, none of it should reach the bundle.
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      join(dataDir, 'daemon.json'),
      JSON.stringify({
        pid: 99999,
        port: 3099,
        token: 'Authorization: Bearer secret-token-XYZ at /opt/wb/server.ts:42',
        version: '0.0.4',
        startedAt: FIXED_TS,
      }),
    )

    const outcome = await runDaemonSupportBundle({
      dataDir,
      outputDir,
      now: () => FIXED_TS,
      packageVersion: '0.0.4-test',
      platform: { os: 'darwin', nodeVersion: 'v22.0.0' },
    })
    expect(outcome.exitCode).toBe(0)

    const concatenated = (
      await Promise.all(
        ['manifest.json', 'status.json', 'doctor.json'].map((n) =>
          readFile(join(outputDir, n), 'utf-8'),
        ),
      )
    ).join('')
    expect(concatenated).not.toContain('secret-token-XYZ')
    expect(concatenated).not.toMatch(/Authorization/i)
    expect(concatenated).not.toMatch(/Bearer/i)
    expect(concatenated).not.toMatch(/\/opt\//)
    expect(concatenated).not.toMatch(/\/Users\//)
    expect(concatenated).not.toMatch(/\.ts:\d/)
    // stdout itself is the structured JSON — the result echoes
    // outputDir which IS allowed (caller-provided path, not a
    // leaked secret), but it must not carry the seeded token.
    expect(outcome.stdout).not.toContain('secret-token-XYZ')
    expect(outcome.stdout).not.toMatch(/Bearer/i)
  })

  it('non-empty output dir: exit 1, generic stderr, pre-existing canary preserved', async () => {
    const dataDir = join(root, 'data-nonempty')
    const outputDir = join(root, 'bundle-nonempty')
    await mkdir(outputDir, { recursive: true })
    const canaryPath = join(outputDir, 'pre-existing.txt')
    await writeFile(canaryPath, 'canary-content')

    const outcome = await runDaemonSupportBundle({
      dataDir,
      outputDir,
      now: () => FIXED_TS,
      packageVersion: '0.0.4-test',
    })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.stdout).toBe('')
    expect(outcome.stderr).toMatch(/output directory must be empty/i)
    // stderr does NOT echo the resolved outputDir.
    expect(outcome.stderr).not.toContain(outputDir)
    expect(outcome.stderr).not.toContain(root)
    // Canary survives — no bundle files written.
    expect(await readFile(canaryPath, 'utf-8')).toBe('canary-content')
    expect((await readdir(outputDir)).sort()).toEqual(['pre-existing.txt'])
  })
})

describe('CLI dispatcher: whiteboard daemon support-bundle --json', () => {
  it('drives main(): writes one JSON object to stdout, no stderr, files on disk', async () => {
    const dataDir = join(root, 'cli-data')
    const outputDir = join(root, 'cli-out')

    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() =>
      main([
        'daemon',
        'support-bundle',
        '--json',
        `--data-dir=${dataDir}`,
        `--output-dir=${outputDir}`,
      ]),
    )

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.endsWith('\n')).toBe(true)
    const result = JSON.parse(stdout.trim())
    expect(Array.isArray(result)).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.files).toEqual(['status.json', 'doctor.json', 'manifest.json'])

    expect((await readdir(outputDir)).sort()).toEqual([
      'doctor.json',
      'manifest.json',
      'status.json',
    ])
  })

  it('missing --output-dir: exit 64, stdout empty, stderr usage error', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['daemon', 'support-bundle', '--json', `--data-dir=${root}`]))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/--output-dir.*required/i)
  })

  it('usage block lists support-bundle for unknown subcommand', async () => {
    const {
      result: exitCode,
      stdout,
      stderr,
    } = await captureStdio(() => main(['daemon', 'this-is-not-a-real-subcommand', '--json']))
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/whiteboard daemon support-bundle\s+--json/)
  })
})
