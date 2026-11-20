import type { LoroDoc } from 'loro-crdt'
import type { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'

/**
 * The workspace record, or null for BOTH an unreadable store and an
 * unavailable workspace id.
 *
 * The id read has to sit INSIDE the isolation, which is why this is a
 * function rather than the `docs.open(getBrowserWorkspaceId()).catch(…)` each
 * caller would otherwise write: an argument is evaluated before `open`
 * returns a promise, so an accessor throw is not a rejection that `.catch`
 * can absorb — it escapes the caller entirely, past the very null branch the
 * caller wrote to stay standing when storage is unavailable.
 */
export async function openWorkspaceOrNull(docs: BrowserWorkspaceDocs): Promise<LoroDoc | null> {
  try {
    return await docs.open(getBrowserWorkspaceId())
  } catch {
    return null
  }
}
