// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createWhiteboardCommands } from '../lib/commands/create-commands.js'
import type { WhiteboardCommandDeps } from '../lib/commands/types.js'
import { documentLabels } from './browser-document-slots.js'
import { daemonDocumentLabels } from './daemon-document-slots.js'

// What each document page hands the in-page command surface is the identity
// a model reads back from whiteboard_get_app_context, so it is asserted
// through the command rather than as a bare object: a page and the command
// can only disagree about its shape at runtime.
async function answerFor(
  provider: WhiteboardCommandDeps['provider'],
  canvas: WhiteboardCommandDeps['canvas'],
) {
  return createWhiteboardCommands({ current: { provider, canvas } }).getAppContext()
}

describe('the identity a document page hands its commands', () => {
  it('names the browser page by workspace, document id and path', async () => {
    const labels = documentLabels(
      { workspaceId: '01JWS', documentId: '01JDOC', path: 'notes/plan.md' },
      'Plan',
    )

    expect(await answerFor({ kind: 'browser' }, labels.commandCanvas)).toEqual({
      provider: { mode: 'browser' },
      canvas: { workspaceId: '01JWS', documentId: '01JDOC', path: 'notes/plan.md' },
    })
  })

  it('names the daemon page by its document id, not by its path', async () => {
    const labels = daemonDocumentLabels(
      { workspaceId: '01JWS', path: 'notes/plan.md' },
      { recorded: undefined, listed: undefined },
      '01JDOC',
    )

    expect(
      await answerFor(
        { kind: 'daemon', daemonBaseUrl: 'http://127.0.0.1:9' },
        labels.commandCanvas,
      ),
    ).toEqual({
      provider: { mode: 'daemon' },
      canvas: { workspaceId: '01JWS', documentId: '01JDOC', path: 'notes/plan.md' },
    })
  })

  it('answers no daemon identity until the listing names the document id', () => {
    const labels = daemonDocumentLabels(
      { workspaceId: '01JWS', path: 'notes/plan.md' },
      { recorded: undefined, listed: undefined },
      undefined,
    )

    expect(labels.commandCanvas).toBeNull()
  })
})
