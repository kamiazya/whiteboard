import { readWorkspaceNodes } from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'
import type { WorkspaceRecord } from '../lib/follow-workspace-writes.js'

const ports = new WeakMap<LoroDoc, WorkspaceRecord>()

/**
 * A `LoroDoc` a test imports into, as the record a list follows. One port per
 * doc, so a hook keyed on it re-subscribes only when the record is replaced.
 */
export function recordPortOf(doc: LoroDoc): WorkspaceRecord {
  let port = ports.get(doc)
  if (port === undefined) {
    port = {
      nodes: () => readWorkspaceNodes(doc),
      subscribeImports: (listener) =>
        doc.subscribe((event) => {
          if (event.by === 'import') listener()
        }),
    }
    ports.set(doc, port)
  }
  return port
}
