/**
 * ADR-0046 decision 10 holds for the tools that exist, not for the ones the
 * gate's own tests imagine: the gate keys on the `workspaceId` field of a
 * tool's input, so a tool that names its workspace any other way would run
 * ungated and pass every fake-tool test. This runs the REAL tool set through
 * it.
 */
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { InMemoryDocumentIndex, InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { createServer, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import { FakeVersionHistory } from '@kamiazya/whiteboard-server-core/test-utils/fake-version-history'
import { describe, expect, it } from 'vitest'
import type { ResolvedGrant } from '../security/credential-resolver.js'
import {
  gatedByMembership,
  runAsMcpCaller,
  WORKSPACE_OPTIONAL_TOOLS,
} from '../security/mcp-caller.js'
import type { MemberProfileStore } from '../security/member-profile-store.js'
import { liveDocuments } from '../store/live-documents.js'
import { connectDocumentTools } from './_test-document-tools-client.js'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'

function realTools() {
  return createServer({
    documentStore: new InMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    versions: new FakeVersionHistory(),
    liveDocuments: liveDocuments(),
    facetRegistry: bundledFacetRegistry,
  } as unknown as ServerDeps).tools
}

describe('the membership gate over the registered tools', () => {
  it('sees every registered tool, so the walks below are not vacuous', async () => {
    const names = Object.values(realTools()).map((tool) => tool.name)
    expect([...names].sort()).toEqual([...ALL_REGISTERED_TOOLS].sort())
    const { tools } = await connectDocumentTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([...ALL_REGISTERED_TOOLS].sort())
  })

  // A required field is what the gate selects on; an optional one is a way
  // to skip it. The allowlist is the one deliberate exception, and each entry
  // is a registered tool, so a retired tool cannot leave a permission behind.
  it('requires workspaceId on every tool except the allowlisted ones', async () => {
    const { tools } = await connectDocumentTools()
    for (const tool of tools) {
      const required = tool.inputSchema.required ?? []
      const allowlisted = WORKSPACE_OPTIONAL_TOOLS.has(tool.name)
      expect(
        required.includes('workspaceId') || allowlisted,
        `${tool.name} has no required workspaceId and is not allowlisted`,
      ).toBe(true)
      if (allowlisted) {
        expect(tool.inputSchema.properties).toHaveProperty('workspaceId')
        expect(required).not.toContain('workspaceId')
      }
    }
    for (const name of WORKSPACE_OPTIONAL_TOOLS) {
      expect(ALL_REGISTERED_TOOLS as readonly string[]).toContain(name)
    }
  })

  it('refuses every tool to a caller who is not signed in as a person', async () => {
    const index = { resolveWorkspace: async () => null }
    const gated = gatedByMembership(realTools(), index)
    const grant: ResolvedGrant = { kind: 'external-bearer', scopes: ['mcp:call'] }
    const members = {
      membersOnly: async () => true,
      profileForBinding: async () => null,
    } as unknown as MemberProfileStore
    const entries = Object.values(gated)
    expect(entries.length).toBe(ALL_REGISTERED_TOOLS.length)
    for (const tool of entries) {
      await expect(
        runAsMcpCaller({ grant, members }, () =>
          (tool as { execute(input: unknown): Promise<unknown> }).execute({ workspaceId: 'ws-1' }),
        ),
        tool.name,
      ).rejects.toThrow(/requires_person_session/)
    }
  })

  it('refuses every tool that names no workspace, except the allowlisted ones', async () => {
    const gated = gatedByMembership(realTools(), { resolveWorkspace: async () => null })
    const grant: ResolvedGrant = { kind: 'external-bearer', scopes: ['mcp:call'] }
    const members = { membersOnly: async () => true } as unknown as MemberProfileStore
    for (const tool of Object.values(gated)) {
      if (WORKSPACE_OPTIONAL_TOOLS.has(tool.name)) continue
      await expect(
        runAsMcpCaller({ grant, members }, () =>
          (tool as { execute(input: unknown): Promise<unknown> }).execute({}),
        ),
        tool.name,
      ).rejects.toThrow(/workspace_required/)
    }
  })
})
