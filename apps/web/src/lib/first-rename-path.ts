import { deriveWorkspaceSegment, documentPathSchema, pathBelow } from '@kamiazya/whiteboard-model'
import { isGeneratedPath } from './new-document-path.js'

/**
 * The address a document moves to when it is named for the first time, or
 * `null` when it stays where it is.
 *
 * A path is the URL, and a document made at `untitled` that is then called
 * "Checkout Architecture" would otherwise carry two names for one board. The
 * address follows the name exactly once: while the path is still one the
 * create flow generated. Anything else was placed by a person (or by an
 * earlier rename) and a later rename must not move it out from under a link.
 *
 * The segment rule is the workspace address's (`deriveWorkspaceSegment`), so
 * a name in a script the charset cannot spell yields no address and the path
 * stays generated rather than becoming a mangled approximation. Collisions
 * number from `-2` within the folder, as the create flow does. An address
 * that would itself read as generated ("Untitled 2") is refused, or a second
 * rename could move the document again.
 */
export function pathAfterFirstRename(
  path: string,
  name: string,
  existingPaths: readonly string[],
): string | null {
  if (!isGeneratedPath(path)) return null
  const segment = deriveWorkspaceSegment(name)
  if (segment === undefined) return null

  const cut = path.lastIndexOf('/') + 1
  const folder = path.slice(0, cut)
  const siblings = new Set(
    existingPaths.flatMap((other) => {
      const rest = pathBelow(folder.slice(0, -1), other)
      return rest === undefined ? [] : [rest]
    }),
  )
  let leaf = segment
  for (let n = 2; siblings.has(leaf); n++) leaf = `${segment}-${n}`

  if (isGeneratedPath(leaf)) return null
  const next = `${folder}${leaf}`
  return documentPathSchema.safeParse(next).success ? next : null
}
