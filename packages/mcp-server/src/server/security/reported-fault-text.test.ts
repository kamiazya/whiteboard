/**
 * A fault a tool REPORTS in a successful answer never reaches the thrown-error
 * path that withholds a fault's text from a server-mode member, so the root
 * composes the same judgement into `ServerDeps.reportedFaultText`. Driven
 * through the deps `resolveServerDeps` composes and the real tool.
 */
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { createWorkspaceEditTool } from '@kamiazya/whiteboard-server-core/test-utils/tools'
import { describe, expect, it } from 'vitest'
import { createContainer, resolveServerDeps } from '../../di/container.js'
import { storeMemoryModule } from '../../shared/test-utils/store-memory.module.js'
import { ALL_AUTH_SCOPES } from './auth-strategy.js'
import { runAsMcpCaller, toolErrorText } from './mcp-caller.js'
import type { MemberProfileStore } from './member-profile-store.js'

const WS = 'plans'

const storageFault = () =>
  Object.assign(new Error('SQLITE_IOERR /srv/data/tenant/x.db'), { name: 'SqliteError' })

// The follow pass lists the workspace again after the move; a listing that
// fails THERE is a pass that could not run while the move stands.
function failingSecondListing(index: DocumentIndex): DocumentIndex {
  let listings = 0
  return new Proxy(index, {
    get(target, prop, receiver) {
      if (prop === 'listDocuments') {
        return async (input: Parameters<DocumentIndex['listDocuments']>[0]) => {
          listings += 1
          if (listings === 2) throw storageFault()
          return index.listDocuments(input)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function moveWithFailingFollow() {
  const deps = resolveServerDeps(createContainer(storeMemoryModule))
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  const seeded = await createWorkspaceEditTool(deps).execute({
    workspaceId: WS,
    ops: [{ op: 'document.create', path: 'design/login', kind: 'markdown' }],
  })
  const out = await createWorkspaceEditTool({
    ...deps,
    documentIndex: failingSecondListing(deps.documentIndex),
  }).execute({
    workspaceId: WS,
    ops: [
      { op: 'document.move', documentId: seeded.results[0]?.documentId ?? '', path: 'archive' },
    ],
  })
  return out.results[0]?.follow
}

// The gate is not under test, only the caller's presence: an unused store.
const members = {} as MemberProfileStore
const asMember = <T>(fn: () => Promise<T>) =>
  runAsMcpCaller({ grant: { kind: 'external-bearer', scopes: ALL_AUTH_SCOPES }, members }, fn)

describe('a reported fault, as the composed ServerDeps quote it', () => {
  it('withholds a storage fault from a server-mode member, as a thrown one is', async () => {
    const follow = await asMember(moveWithFailingFollow)
    const thrownText = await asMember(async () =>
      toolErrorText('wb_workspace_edit', storageFault()),
    )
    expect(follow).toEqual({ error: thrownText })
    expect(JSON.stringify(follow)).not.toContain('/srv/data')
    expect(JSON.stringify(follow)).toContain('internal_error')
  })

  it("quotes the fault in full to the local daemon's owner", async () => {
    expect(await moveWithFailingFollow()).toEqual({ error: 'SQLITE_IOERR /srv/data/tenant/x.db' })
  })
})
