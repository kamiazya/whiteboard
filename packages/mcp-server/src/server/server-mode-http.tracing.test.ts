/**
 * Server mode starts tracing itself.
 *
 * `whiteboard server run` goes `server-run.ts` to `startServerModeHttp` and
 * never through the dev entry, so tracing initialised only there left
 * `WHITEBOARD_OTEL=1` / `OTEL_EXPORTER_OTLP_ENDPOINT` a silent no-op on the
 * deployment an operator is most likely to want traces from.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bearerNamesItsSubject, PUBLIC_URL } from './_test-server-mode-harness.js'

let tempDir: string

vi.mock(
  '@hono/node-server',
  async () => (await import('./_test-server-mode-served.js')).nodeServerStub,
)

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

const { startServerModeHttp } = await import('./server-mode-http.js')
const { initTracing } = await import('./observability/tracing.js')

let running: Awaited<ReturnType<typeof startServerModeHttp>> | undefined

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-tracing-'))
  vi.mocked(initTracing).mockClear()
})
afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('startServerModeHttp tracing', () => {
  it('initialises tracing as the server role', async () => {
    running = await startServerModeHttp({
      host: 'board.example',
      port: 443,
      publicBaseUrl: PUBLIC_URL,
      allowedOrigins: [PUBLIC_URL],
      authStrategy: bearerNamesItsSubject,
    })
    expect(initTracing).toHaveBeenCalledTimes(1)
    expect(initTracing).toHaveBeenCalledWith({ role: 'server' })
  })
})
