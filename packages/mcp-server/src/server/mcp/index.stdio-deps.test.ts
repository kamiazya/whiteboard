import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-stdio-deps-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { stdioRootServerDeps } = await import('./index.js')

describe('the stdio root', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
  })

  it('attaches no live-audience notifier, since no SSE client can be in its process', async () => {
    // The packaged stdio entry opens the store in its own process and never
    // reaches the daemon, so a notifier here would announce every edit to
    // streams that exist only in the daemon's process. Until the two are
    // bridged, the honest answer is none: `wb_viewport_set` reports
    // `delivered: false` rather than a delivery nobody received.
    const deps = await stdioRootServerDeps()
    expect(deps.clientNotifier).toBeUndefined()
  })
})
