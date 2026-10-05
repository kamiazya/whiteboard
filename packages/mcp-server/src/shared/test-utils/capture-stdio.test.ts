import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getLogger, setStderrLogDestination } from '../../server/log.js'
import { captureStdio } from './capture-stdio.js'
import { stripComments } from './strip-comments.js'

describe('captureStdio', () => {
  it('sees a logger record on stderr while the suite has the destination muted', async () => {
    const restoreMute = setStderrLogDestination(false)
    try {
      const { stderr } = await captureStdio(async () => {
        getLogger('capture-stdio-test').warning({ marker: 'seen-by-capture' }, 'a record')
      })
      expect(stderr).toContain('seen-by-capture')
    } finally {
      restoreMute()
    }
  })

  it('puts the mute back when it settles, rejected included', async () => {
    const restoreMute = setStderrLogDestination(false)
    try {
      await expect(
        captureStdio(async () => {
          throw new Error('body failed')
        }),
      ).rejects.toThrow('body failed')
      const written: string[] = []
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        written.push(String(chunk))
        return true
      })
      try {
        getLogger('capture-stdio-test').warning({ marker: 'after-capture' }, 'a record')
      } finally {
        spy.mockRestore()
      }
      expect(written.join('')).not.toContain('after-capture')
    } finally {
      restoreMute()
    }
  })
})

// `vitest.log-setup.ts` mutes the logger's stderr destination for the whole
// project. A test that diverts `process.stderr` and then asserts what reached
// it — no secret, no stack frame, nothing at all — sees only the writes that
// bypass the logger unless it opts back in, and passes on exactly the leak it
// exists to catch. So a test file that spies on `process.stderr` either goes
// through `captureStdio` (which opts in) or calls `setStderrLogDestination`
// itself, or is ledgered here as only SILENCING stderr, asserting nothing on it.
//
// Blind spot: the scan matches the `spyOn(process.stderr` spelling. A spy on
// an alias of the stream (`const err = process.stderr; vi.spyOn(err, …)`) or
// a reassigned `process.stderr.write` is not seen.
const SILENCE_ONLY: Readonly<Record<string, string>> = {
  'server/observability/tracing.test.ts':
    'mutes the console span exporter, which writes to stderr; nothing reads what it captured',
}

const SPIES_ON_STDERR = /\bspyOn\(\s*process\.stderr\b/
// Only turning the destination ON opts in: `setStderrLogDestination(false)` is
// the mute itself, and a file calling it has opted further OUT.
const OPTS_IN = /\bsetStderrLogDestination\(\s*true\b|\bcaptureStdio\(/

function testSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testSources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('a test that spies on process.stderr sees what the logger writes there', () => {
  const srcDir = resolve(import.meta.dirname, '..', '..')
  const spying = testSources(srcDir)
    .map((path) => ({
      path: relative(srcDir, path),
      code: stripComments(readFileSync(path, 'utf8')),
    }))
    .filter(({ code }) => SPIES_ON_STDERR.test(code))

  it('reads only turning the destination on, or captureStdio, as opting in', () => {
    expect(OPTS_IN.test('setStderrLogDestination(true)')).toBe(true)
    expect(OPTS_IN.test('await captureStdio(async () => {})')).toBe(true)
    expect(OPTS_IN.test('const restore = setStderrLogDestination(false)')).toBe(false)
  })

  it('finds the files it polices', () => {
    // captureStdio itself, log.test.ts, the native-host CLI test, tracing.
    expect(spying.length).toBeGreaterThanOrEqual(4)
  })

  it('every spying file opts in to the stderr destination or is ledgered as silence-only', () => {
    const blind = spying
      .filter(({ path, code }) => !OPTS_IN.test(code) && SILENCE_ONLY[path] === undefined)
      .map(({ path }) => path)
    expect(blind).toEqual([])
  })

  it('every silence-only entry still spies on stderr and still does not opt in', () => {
    const stale = Object.keys(SILENCE_ONLY).filter((path) => {
      const entry = spying.find((file) => file.path === path)
      return entry === undefined || OPTS_IN.test(entry.code)
    })
    expect(stale).toEqual([])
  })
})
