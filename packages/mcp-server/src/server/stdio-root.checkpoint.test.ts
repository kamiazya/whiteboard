import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CHECKPOINT_QUIET_MS } from '@kamiazya/whiteboard-history'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import {
  createCanvasEditTool,
  type ServerDeps,
  wbDocumentCreate,
} from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-stdio-checkpoint-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { bootStdioRoot } = await import('./stdio-root.js')
const { startBackgroundWork } = await import('./background-work.js')
const { stdioBackgroundWork } = await import('./shared-background-work.js')
const { FileVersionStore } = await import('./store/version-store.js')
const { compactWorkspace } = await import('./store/document-store.js')
const { uninstallAutoCheckpoint } = await import('./store/auto-checkpoint.js')
const { disposeAutoCompact } = await import('./store/auto-compact.js')

/**
 * The published entry is `npx @kamiazya/whiteboard-mcp`, which is this root
 * and no other: no router is mounted, so nothing a router arms is armed. An
 * agent that only ever edits through it must still get History and a
 * compactable op-log, or the workspace's record grows without bound.
 */
describe('the stdio root takes automatic checkpoints for agent-only writes', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
  })

  afterEach(async () => {
    vi.useRealTimers()
    uninstallAutoCheckpoint()
    await disposeAutoCompact()
  })

  async function editThroughStdioDeps(deps: ServerDeps, edits: number) {
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'agent-only',
      kind: 'spatial',
    })
    const edit = createCanvasEditTool(deps)
    for (let i = 0; i < edits; i++) {
      await edit.execute({
        workspaceId: 'ws-1',
        documentId: created.documentId,
        ops: [
          {
            op: 'node.add',
            node: textNode({ id: `n${i}`, text: `n${i}`, x: i * 100, y: 0, width: 80, height: 40 }),
          },
        ],
      })
    }
  }

  it('lands a version once the document has been quiet, so compaction has a floor', async () => {
    const { serverDeps, scope } = await bootStdioRoot()
    const versions = new FileVersionStore(scope)
    const work = startBackgroundWork(stdioBackgroundWork(scope))
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      await editThroughStdioDeps(serverDeps, 3)
      expect(await versions.list('ws-1', 'agent-only')).toHaveLength(0)
      expect((await compactWorkspace('ws-1', versions)).reason).toBe('no-versions')

      await vi.advanceTimersByTimeAsync(CHECKPOINT_QUIET_MS + 1)
      vi.useRealTimers()

      await vi.waitFor(async () => {
        expect(await versions.list('ws-1', 'agent-only')).toHaveLength(1)
      })
      expect((await compactWorkspace('ws-1', versions)).reason).not.toBe('no-versions')
    } finally {
      await work.stopAll()
    }
  })

  it('takes the pending checkpoint when the process shuts down before the quiet window ends', async () => {
    const { serverDeps, scope } = await bootStdioRoot()
    const versions = new FileVersionStore(scope)
    const work = startBackgroundWork(stdioBackgroundWork(scope))
    await editThroughStdioDeps(serverDeps, 2)
    expect(await versions.list('ws-1', 'agent-only')).toHaveLength(0)

    await work.stopAll()

    expect(await versions.list('ws-1', 'agent-only')).toHaveLength(1)
  })
})
