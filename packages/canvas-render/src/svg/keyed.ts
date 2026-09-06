/**
 * The keyed projection of the SVG document: the same bytes
 * `renderSceneToSvg` emits, cut at the seams a DOM patch layer needs.
 * Every top-level scene entry becomes one `<g data-wb-key="…">` group; the
 * document-chrome pieces that live outside any entry — `<defs>` and the
 * background rect — become the pseudo-groups `#defs` / `#background`. A
 * consumer mounts `svg` once, then on the next render compares each
 * group's string against what it holds and replaces only the ones that
 * differ — string equality IS change detection, because the serializer is
 * canonical and deterministic.
 *
 * Two invariants the tests pin:
 * - Removing the wrappers reproduces `renderSceneToSvg` byte-for-byte
 *   (both share `buildSvgDocumentParts`, so they cannot drift).
 * - `svg` equals `rootOpen` + the groups' strings + `</svg>`, so the
 *   mounted document and the patch units are the same bytes by
 *   construction.
 *
 * The wrappers are an EDITOR-MODE projection: exports and the MCP render
 * tool keep calling `renderSceneToSvg`, whose bytes carry no keys.
 */

import { sceneEntries } from '../scene-entry-keys.js'
import type { Scene } from '../scene-graph.js'
import { buildSvgDocumentParts, type SvgDocumentOptions } from './backend.js'
import { formatCoord } from './format.js'
import { serializeSvg, serializeSvgChild, serializeSvgChunks } from './serialize.js'
import { el, type SvgChild } from './vnode.js'

export interface KeyedSvgGroup {
  readonly key: string
  /** The group's exact document bytes: `<g data-wb-key="KEY">…</g>` for a
   * scene entry, the bare element for a pseudo-group. */
  readonly svg: string
  /**
   * This group draws the ANNOTATION LAYER rather than the document — a
   * conversation's pin, count, leader or bubble (see `sceneEntries`).
   *
   * Out-of-band on purpose: it never reaches `svg`, so the projection's
   * bytes stay `renderSceneToSvg`'s, which is what the consumer's
   * `dangerouslySetInnerHTML` safety argument rests on.
   *
   * A patch layer wants it because the whole set arrives and leaves
   * together: with the default `showResolved`, resolving a conversation
   * removes all of it at once, and with the toggle on all of it changes
   * paint at once. Nothing here says what to DO about that.
   */
  readonly annotation?: true
}

export interface KeyedSvgRender {
  /** The full document — identical bytes to mounting the groups yourself. */
  readonly svg: string
  /** The root `<svg …>` open tag, exactly as it appears in `svg`. */
  readonly rootOpen: string
  /** Root attributes as raw (unescaped) strings, for `setAttribute` when a
   * patch keeps the mounted root element and only its attributes moved. */
  readonly rootAttrs: Readonly<Record<string, string>>
  readonly groups: ReadonlyArray<KeyedSvgGroup>
}

function isEmptyChild(child: SvgChild): boolean {
  return Array.isArray(child) && child.length === 0
}

export function renderSceneToKeyedSvg(scene: Scene, options?: SvgDocumentOptions): KeyedSvgRender {
  const parts = buildSvgDocumentParts(scene, options)
  const entries = sceneEntries(scene)

  const groups: KeyedSvgGroup[] = []
  if (!isEmptyChild(parts.defs)) groups.push({ key: '#defs', svg: serializeSvgChild(parts.defs) })
  if (!isEmptyChild(parts.background)) {
    groups.push({ key: '#background', svg: serializeSvgChild(parts.background) })
  }
  parts.body.forEach((child, index) => {
    const entry = entries[index]
    const key = entry?.key ?? `preamble#${index}`
    groups.push({
      key,
      svg: serializeSvg(el('g', { 'data-wb-key': key }, [child])),
      ...(entry?.annotation === true ? { annotation: true as const } : {}),
    })
  })

  const [rootOpen] = serializeSvgChunks(el('svg', parts.rootAttrs, []))
  const rootAttrs = Object.fromEntries(
    Object.entries(parts.rootAttrs)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [
        name,
        typeof value === 'number' ? formatCoord(value) : String(value),
      ]),
  )

  return {
    svg: `${rootOpen}${groups.map((group) => group.svg).join('')}</svg>`,
    rootOpen: rootOpen ?? '<svg>',
    rootAttrs,
    groups,
  }
}
