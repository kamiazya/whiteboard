import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getLogger as getServerCoreLogger,
  setLogSink as setServerCoreLogSink,
} from '@kamiazya/whiteboard-server-core'
import { LOG_LEVELS } from '@kamiazya/whiteboard-server-core/log-levels'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { createApp } from './app.js'
import { captureLogsForTests } from './log.js'
import { testStoreScope } from './routes/_test-helpers.js'
import { routeServerCoreLogs } from './server-core-logs.js'

/**
 * server-core drops every record until a root installs a sink, and its
 * fail-open sites log a warning and carry on, so a root that never arms one
 * is invisible: nothing throws and nothing reaches an operator. Armed once at
 * a root's startup, never as a side effect of loading a module.
 */
const silent = () => {}

function emitFromServerCore(): ReturnType<typeof captureLogsForTests> {
  const capture = captureLogsForTests('debug')
  getServerCoreLogger('some-server-core-scope').error('something failed', { workspaceId: 'ws-1' })
  getServerCoreLogger('some-server-core-scope').warning('no fields')
  capture.restore()
  return capture
}

beforeEach(() => setServerCoreLogSink(silent))
afterEach(() => setServerCoreLogSink(silent))

describe('routeServerCoreLogs', () => {
  it('forwards a server-core record to this root’s logger, fields first', () => {
    routeServerCoreLogs()

    expect(emitFromServerCore().records).toEqual([
      expect.objectContaining({
        scope: 'some-server-core-scope',
        level: 'error',
        msg: 'something failed',
        data: expect.objectContaining({ workspaceId: 'ws-1' }),
      }),
      expect.objectContaining({
        scope: 'some-server-core-scope',
        level: 'warning',
        msg: 'no fields',
      }),
    ])
  })

  // One list of levels across the seam: a level server-core can emit that this
  // logger lacks would be forwarded under a name pino has no method for.
  it.each(LOG_LEVELS)('forwards a %s record at the same level', (level) => {
    routeServerCoreLogs()
    const capture = captureLogsForTests('debug')
    getServerCoreLogger('level-scope')[level]('at this level')
    capture.restore()

    expect(capture.records).toEqual([
      expect.objectContaining({ scope: 'level-scope', level, msg: 'at this level' }),
    ])
  })

  it('drops them until it is called', () => {
    expect(emitFromServerCore().records).toEqual([])
  })
})

describe('createApp', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-core-logs-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('arms the server-core sink, so both HTTP roots forward its records', () => {
    createApp({
      authMode: 'local-daemon',
      serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
      dataLayout: testStoreScope(dir).layout,
      touch: vi.fn(),
      getStatus: () => ({
        ok: true,
        pid: 1,
        socketPath: '/run/wb.sock',
        version: PACKAGE_VERSION,
        startedAt: '2026-04-23T00:00:00.000Z',
        uptimeMs: 1,
        idleForMs: 0,
        auth: { mode: 'local-token', hasToken: false },
        storage: { dataDir: dir, dataDirWritable: true },
        mcp: { httpEnabled: true },
        clients: { connected: 0, ready: 0 },
      }),
    })

    expect(emitFromServerCore().records.map((record) => record.msg)).toEqual([
      'something failed',
      'no fields',
    ])
  })
})
