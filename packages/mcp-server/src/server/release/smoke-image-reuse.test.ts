// `resolveServerImage` is what makes one image build per commit real: CI
// builds the server image once (with a layer cache a fresh runner cannot
// otherwise keep) and hands the tag to each Docker smoke through
// WHITEBOARD_SMOKE_IMAGE.
//
// Its one dangerous failure mode is a silent fallback. If a named-but-absent
// image quietly rebuilt, "one build per commit" would become two while every
// log still read as success — the same shape as the missing build arg this
// work uncovered, where the pipeline was green about a path it never ran.

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

const { resolveServerImage } = (await import(
  pathToFileURL(join(ROOT, 'tests/e2e/distribution/smoke-helpers.mjs')).href
)) as {
  resolveServerImage: (options: {
    repoRoot: string
    defaultTag: string
    docker: (args: string[], opts?: object) => { status: number | null }
    fail: (message: string) => never
    label: string
  }) => string
}

function harness(dockerStatus: (args: string[]) => number) {
  const calls: string[][] = []
  const failures: string[] = []
  return {
    calls,
    failures,
    options: {
      repoRoot: ROOT,
      defaultTag: 'whiteboard-server-smoke:test',
      label: 'test',
      docker: (args: string[]) => {
        calls.push(args)
        return { status: dockerStatus(args) }
      },
      fail: ((message: string) => {
        failures.push(message)
        throw new Error(message)
      }) as (message: string) => never,
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('resolveServerImage', () => {
  it('builds into the default tag when no image is offered', () => {
    vi.stubEnv('WHITEBOARD_SMOKE_IMAGE', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const h = harness(() => 0)
    expect(resolveServerImage(h.options)).toBe('whiteboard-server-smoke:test')
    expect(h.calls[0]?.[0]).toBe('build')
  })

  it('passes NODE_VERSION on the build it runs', () => {
    vi.stubEnv('WHITEBOARD_SMOKE_IMAGE', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const h = harness(() => 0)
    resolveServerImage(h.options)
    const build = h.calls[0] ?? []
    const argIndex = build.indexOf('--build-arg')
    expect(argIndex).toBeGreaterThanOrEqual(0)
    expect(build[argIndex + 1]).toMatch(/^NODE_VERSION=\d+/)
  })

  it('reuses an offered image and runs no build', () => {
    vi.stubEnv('WHITEBOARD_SMOKE_IMAGE', 'whiteboard-server:dry-run')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const h = harness(() => 0)
    expect(resolveServerImage(h.options)).toBe('whiteboard-server:dry-run')
    expect(h.calls.map((c) => c[0])).toEqual(['image'])
  })

  it('fails on an offered image that is absent, rather than rebuilding', () => {
    vi.stubEnv('WHITEBOARD_SMOKE_IMAGE', 'whiteboard-server:missing')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const h = harness((args) => (args[0] === 'image' ? 1 : 0))
    expect(() => resolveServerImage(h.options)).toThrow(/not present locally/)
    expect(
      h.calls.some((c) => c[0] === 'build'),
      'a silent rebuild would turn one build per commit back into two, with nothing red',
    ).toBe(false)
  })

  it('fails when its own build fails', () => {
    vi.stubEnv('WHITEBOARD_SMOKE_IMAGE', undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const h = harness(() => 1)
    expect(() => resolveServerImage(h.options)).toThrow(/docker build failed/)
  })
})
