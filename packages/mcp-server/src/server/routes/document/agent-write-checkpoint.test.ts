// A workspace only an agent edits must get the same history the HTTP update
// path gives one: a checkpoint row at the pause, and with it the floor that
// lets compaction fold the op-log. Compaction declines `no-versions` while no
// row exists, so an agent-only workspace that never got a checkpoint grew its
// op-log without bound whatever the debounce did.
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTestServerDeps, withTempDataDir } from '../_test-helpers.js'
import type { AutoVersionTrigger } from './auto-version.js'

const tmp = withTempDataDir('whiteboard-agent-checkpoint-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('../document.js')
const { createSharedWorkers, sharedBackgroundWork } = await import(
  '../../shared-background-work.js'
)
const { uninstallAutoCheckpoint } = await import('../../store/auto-checkpoint.js')
const { FileVersionStore } = await import('../../store/version-store.js')
const { compactWorkspace } = await import('../../store/document-store.js')
const { disposeAutoCompact } = await import('../../store/auto-compact.js')
const { createWorkspaceEditTool, createCanvasEditTool } = await import(
  '@kamiazya/whiteboard-server-core'
)

describe('an agent-only workspace', () => {
  let deps: ServerDeps
  beforeEach(async () => {
    deps = await resolveTestServerDeps(tmp.dir)
  })

  it('gets a checkpoint at the pause, which lets compaction proceed past no-versions', async () => {
    let trigger: AutoVersionTrigger | undefined
    createDocumentRouter({
      serverDeps: deps,
      // Long enough that only the flush below can take the checkpoint.
      autoVersionQuietMs: 60 * 60_000,
      onAutoVersionTrigger: (t) => {
        trigger = t
      },
    })
    // The root arms the router's scheduler for the agent write path; the
    // router itself installs nothing.
    sharedBackgroundWork(createSharedWorkers('instance-a'), {
      checkpointScheduler: () => trigger,
      fileGc: { start: () => {}, stop: async () => {} },
    })
      .find((entry) => entry.name === 'auto-checkpoint')
      ?.worker?.start()
    try {
      const edited = await createWorkspaceEditTool(deps).execute({
        workspaceId: 'agent-only',
        createWorkspace: true,
        ops: [{ op: 'document.create', path: 'board', kind: 'spatial' }],
      })
      const workspaceId = edited.workspaceId
      const documentId = edited.results[0]?.documentId
      if (documentId === undefined) throw new Error('document.create returned no id')

      const canvasEdit = createCanvasEditTool(deps)
      for (let i = 0; i < 5; i += 1) {
        await canvasEdit.execute({
          workspaceId,
          documentId,
          ops: [
            {
              op: 'node.add',
              node: textNode({
                id: `n${i}`,
                text: `note ${i}`,
                x: i * 100,
                y: 0,
                width: 80,
                height: 40,
              }),
            },
          ],
        })
      }

      const versions = new FileVersionStore()
      expect(await versions.earliestWorkspaceFrontiers(workspaceId)).toBeNull()

      await trigger?.flush()

      expect(await versions.earliestWorkspaceFrontiers(workspaceId)).not.toBeNull()
      const compaction = await compactWorkspace(workspaceId, versions)
      expect(compaction.reason).not.toBe('no-versions')
    } finally {
      trigger?.stop()
      uninstallAutoCheckpoint()
      await disposeAutoCompact()
    }
  })
})
