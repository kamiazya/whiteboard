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
import type { CanvasColor } from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceFilesSource } from '../lib/files-source.js'
import { libraryWithTagColour } from '../lib/tag-colour.js'

export interface TagVocabulary {
  readonly library: TagLibrary
  readonly inUse: readonly string[]
  /**
   * Colour one tag in the workspace's tag library (`undefined` clears it) and
   * serve the library as the keeper then holds it. Absent when the keeper
   * cannot write the library, so a surface omits the entry rather than
   * offering one that cannot happen. Rejects for a tag with no `key:value`
   * form to declare.
   */
  readonly setTagColour?: (tag: string, colour: CanvasColor | undefined) => Promise<void>
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
  const [read, setRead] = useState<TagVocabulary | undefined>(undefined)
  // The writer judges against what the page shows NOW, not what it showed
  // when the writer was made, so two colourings in a row build on each other.
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    if (source === null) {
      setRead(undefined)
      return
    }
    let cancelled = false
    readTagVocabulary(source).then(
      (next) => {
        if (!cancelled) setRead(next)
      },
      () => {
        if (!cancelled) setRead(undefined)
      },
    )
    return () => {
      cancelled = true
    }
  }, [source])
  const write = source?.writeTagLibrary?.bind(source)
  const setTagColour = useCallback(
    async (tag: string, colour: CanvasColor | undefined) => {
      if (source === null || write === undefined) return
      const shown = latest.current
      const next = libraryWithTagColour(shown?.library ?? {}, tag, colour, shown?.inUse ?? [])
      if (next === undefined)
        throw new Error(`"${tag}" is not a key:value tag, so it has no colour to declare`)
      await write(next)
      setRead(await readTagVocabulary(source))
    },
    [source, write],
  )
  return useMemo(
    () => (read === undefined ? undefined : write === undefined ? read : { ...read, setTagColour }),
    [read, write, setTagColour],
  )
}
