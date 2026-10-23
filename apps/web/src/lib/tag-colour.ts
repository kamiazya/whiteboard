import { type CanvasColor, parseScopedTag } from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'

type ValueDeclaration = NonNullable<TagLibrary[string]['values']>[string]

/**
 * The library with ONE tag's colour set (or cleared), for the keeper to
 * write; `undefined` for a plain tag, which the library — keyed by
 * `key:value` — has no place to colour.
 *
 * A key that declares no `values` admits any value, and one that declares
 * some admits only those. Giving a value on an open key its first
 * declaration would therefore close the key, so the values the workspace
 * already carries under it are declared alongside (without a colour) and
 * stay admitted. Clearing never removes a declaration, only its colour, so
 * a value the library admitted stays admitted.
 */
export function libraryWithTagColour(
  library: TagLibrary,
  tag: string,
  colour: CanvasColor | undefined,
  inUse: readonly string[],
): TagLibrary | undefined {
  const scoped = parseScopedTag(tag)
  if (scoped === undefined) return undefined
  const declared = library[scoped.key]
  if (colour === undefined && declared?.values?.[scoped.value] === undefined) return library
  const seeded: Record<string, ValueDeclaration> =
    declared?.values === undefined
      ? Object.fromEntries(
          inUse.flatMap((carried) => {
            const other = parseScopedTag(carried)
            return other?.key === scoped.key ? [[other.value, {}] as const] : []
          }),
        )
      : declared.values
  const { color: _previous, ...rest } = seeded[scoped.value] ?? {}
  return {
    ...library,
    [scoped.key]: {
      ...declared,
      values: {
        ...seeded,
        [scoped.value]: colour === undefined ? rest : { ...rest, color: colour },
      },
    },
  }
}
