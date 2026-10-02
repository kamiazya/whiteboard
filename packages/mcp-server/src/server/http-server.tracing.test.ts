/**
 * The local daemon starts tracing itself.
 *
 * `whiteboard daemon run` calls `startHttpServer` in-process and never passes
 * through the dev entry's `main`, so tracing initialised only there left
 * `WHITEBOARD_OTEL=1` a silent no-op on the packaged daemon — while the spans
 * it would have exported were compiled into every `createApp`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testSocketPath } from '../shared/test-utils/socket-fetch.js'

let tempDir: string

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js')
  return {
    ...actual,
    get DATA_DIR() {
      return tempDir
    },
    getDataDir: () => tempDir,
  }
})

vi.mock('./observability/tracing.js', async () => ({
  ...(await vi.importActual<typeof import('./observability/tracing.js')>(
    './observability/tracing.js',
  )),
  initTracing: vi.fn(async () => null),
}))

const { startHttpServer } = await import('./http-server.js')
const { initTracing } = await import('./observability/tracing.js')

describe('startHttpServer tracing', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-http-tracing-'))
    vi.mocked(initTracing).mockClear()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('initialises tracing as the daemon role', async () => {
    const running = await startHttpServer({ socketPath: testSocketPath() })
    try {
      expect(initTracing).toHaveBeenCalledTimes(1)
      expect(initTracing).toHaveBeenCalledWith({ role: 'daemon' })
    } finally {
      await running.close()
    }
  })
})
