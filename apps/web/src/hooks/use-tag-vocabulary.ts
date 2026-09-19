/**
 * The workspace's tag vocabulary, both layers of ADR-0040 decision 5, as
 * one value the document pages hand their tag rows and the board's render:
 * `inUse` — every tag anywhere in the workspace, for completions — and
 * `library` — what the document at `tags` declares, for the rows' refusals
 * and the board's colour by intent. Read from the keeper's files source,
 * which is where both keepers already answer these (`listTagsInUse`,
 * `readTagLibrary`), so a page does not grow a third way of reading a
 * workspace.
 *
 * Read ONCE per source — a page's keeper binding — never on every edit or
 * document switch: the in-use list is a convenience a session can be one
 * tag behind on, the library changes when someone edits the `tags`
 * document, which is rare, and the browser keeper answers the in-use list
 * by opening every document. A source that cannot answer, or a read that
 * fails, leaves the value absent and the rows complete from the board
 * alone.
 */
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { useEffect, useState } from 'react'
import type { WorkspaceFilesSource } from '../lib/files-source.js'

export interface TagVocabulary {
  readonly library: TagLibrary
  readonly inUse: readonly string[]
}

export async function readTagVocabulary(
  source: Pick<WorkspaceFilesSource, 'listTagsInUse' | 'readTagLibrary'>,
): Promise<TagVocabulary> {
  const [inUse, library] = await Promise.all([
    source.listTagsInUse?.() ?? Promise.resolve([]),
    source.readTagLibrary?.() ?? Promise.resolve({}),
  ])
  return { library, inUse: inUse.map((row) => row.tag) }
}

export function useTagVocabulary(source: WorkspaceFilesSource | null): TagVocabulary | undefined {
  const [vocabulary, setVocabulary] = useState<TagVocabulary | undefined>(undefined)
  useEffect(() => {
    if (source === null) {
      setVocabulary(undefined)
      return
    }
    let cancelled = false
    readTagVocabulary(source).then(
      (next) => {
        if (!cancelled) setVocabulary(next)
      },
      () => {
        if (!cancelled) setVocabulary(undefined)
      },
    )
    return () => {
      cancelled = true
    }
  }, [source])
  return vocabulary
}
