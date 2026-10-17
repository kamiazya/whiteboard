import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from './log.js'

// The temp fallback is per user: a fixed name in the shared temp dir is one
// another user can create first. Spelled out here rather than imported, so
// the expectation is not the code under test.
const TMP_FALLBACK_NAME = process.getuid ? `.whiteboard-${process.getuid()}` : '.whiteboard'

const FALLBACK = resolve(tmpdir(), TMP_FALLBACK_NAME)

vi.mock('./config.js', () => ({
  getDataDir: () => FALLBACK,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  DATA_DIR: FALLBACK,
  DIST_WEB_APP_DIR: '/tmp/web-app',
}))
vi.mock('../di/boot-self-host-deps.js', () => ({ bootSelfHostDeps: vi.fn(async () => ({})) }))

const { bootStdioRoot } = await import('./stdio-root.js')

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the stdio root booting on the temp-directory fallback', () => {
  it('warns, naming the directory it will write into', async () => {
    vi.stubEnv('WHITEBOARD_DATA_DIR', '')
    const capture = captureLogsForTests('warning')
    try {
      await bootStdioRoot()
      const warning = capture.records.find((record) => record.data?.dataDir === FALLBACK)
      expect(warning?.level).toBe('warning')
    } finally {
      capture.restore()
    }
  })
})
