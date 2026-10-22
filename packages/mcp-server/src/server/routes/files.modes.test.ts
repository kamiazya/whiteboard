/**
 * An upload is held to the database's modes: a 0600 file in 0700
 * directories. Under the umask alone it lands 0644 in 0755 directories, and
 * on a host bind mount every other host user can read it.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CHMOD_IS_OBSERVABLE } from '../../shared/test-utils/chmod-is-observable.js'
import { PENDING_WRITES_DIRNAME } from '../atomic-write.js'
import { testFilesRouterOptions, testStoreScope, withTempDataDir } from './_test-helpers.js'

const tmp = withTempDataDir('whiteboard-files-modes-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createFilesRouter } = await import('./files.js')

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

describe('the modes an upload is written with', () => {
  it.skipIf(!CHMOD_IS_OBSERVABLE)('writes the file 0600 under 0700 directories', async () => {
    const scope = testStoreScope(tmp.dir)
    const app = createFilesRouter(testFilesRouterOptions(scope))

    const res = await app.request('/api/w/ws-modes/document/board/file/img1', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
    expect(res.status).toBe(204)

    const dir = scope.layout.workspaceFilesDir('ws-modes')
    expect((await modeOf(join(dir, 'img1.png'))).toString(8)).toBe('600')
    expect((await modeOf(dir)).toString(8)).toBe('700')
    expect((await modeOf(join(dir, '..'))).toString(8)).toBe('700')
    expect((await modeOf(join(tmp.dir, PENDING_WRITES_DIRNAME))).toString(8)).toBe('700')
  })
})
