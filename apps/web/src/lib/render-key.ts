/**
 * What identifies one rendered picture of one document (ADR-0027 decision 2).
 *
 * The key crosses a worker boundary and a storage boundary (the OPFS render
 * store, through `renderKeyPath`), so it is a declared value type rather than
 * a string built at each call site, per this repo's Zod discipline. Three
 * call sites concatenating their own key is three chances to disagree, and
 * the two that disagree serve the wrong picture rather than failing.
 */

import { spatialThemeModeSchema } from '@kamiazya/whiteboard-canvas-render'
import { compareCodeUnit, type DocumentKind, documentKindSchema } from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { z } from 'zod'
import type { ResolvedTheme } from './theme.js'

/**
 * Stamped into the bundle by every vite/vitest config (see
 * `renderer-build-id.ts`). Read with NO fallback on purpose: a config that
 * forgets the define throws here, loudly, instead of quietly keying every
 * deploy the same and serving a picture the current renderer would not draw.
 */
declare const __RENDERER_BUILD_ID__: string

export const RENDERER_BUILD_ID: string = __RENDERER_BUILD_ID__

/**
 * The families the broker holds, which is NOT every pipeline a surface can
 * take: `png-raster` is absent because nothing asks the broker for one, and
 * naming it here would claim a storage shape this key cannot address.
 * `render-surfaces.ts` uses this same set as its pipelines, so the ledger
 * cannot name a family the broker does not hold.
 */
const brokeredPipelineSchema = z.enum(['svg', 'outline'])

export type BrokeredPipeline = z.infer<typeof brokeredPipelineSchema>

export const renderKeySchema = z.object({
  /** The code that would produce these bytes. */
  buildId: z.string().min(1),
  /**
   * WHICH picture of the document, not just which document.
   *
   * The broker holds one map, so without this axis a tree row's outline and
   * a list row's SVG name the same entry — and the one that arrives first
   * answers the other, in a type the caller has no reason to check. A path
   * ending `.svg` while holding block geometry is the same mistake written
   * down.
   */
  pipeline: brokeredPipelineSchema,
  documentId: z.string().min(1),
  kind: documentKindSchema,
  /**
   * What the document's content WAS when it was drawn — a list row's content
   * digest, the open document's own content digest — or null from a keeper
   * that cannot say.
   *
   * Null is not a version that happens to be missing — it is the absence of
   * any way to notice a change, so a key carrying it is NOT memoisable (see
   * `isMemoisableKey`). A re-read of the list produces the identical key, so
   * remembering a completed render under it would serve the old picture for
   * as long as the tab is open. It is also what stops persistence being safe
   * until a real content state reaches this surface.
   */
  version: z.string().nullable(),
  /**
   * Set for a spatial document, whose palette is baked into the SVG, and
   * NULL for markdown, whose ink comes from CSS. That asymmetry is the whole
   * reason a markdown row survives a theme toggle: one entry serves both.
   */
  theme: spatialThemeModeSchema.nullable(),
  /**
   * Which theme faces this realm could MEASURE when the picture was drawn
   * (`themeFacesKey`), and NULL for markdown — whose body is measured in
   * the bundled family whatever a theme names, so one entry serves a tab
   * before and after a face lands.
   *
   * The other axis a spatial picture cannot do without. A board that names
   * a theme is drawn in the bundled family until this tab holds that
   * theme's face and in the theme's family after, and a list surface asks
   * for the face only once it has drawn the board once — so without this
   * the memo, and the worker's store behind it, would answer that second
   * ask with the first picture. It is deliberately the whole held set
   * rather than this document's own family: a key is built before the
   * canvas is decoded, and the thread that builds it does not know which
   * family the board wants. The cost is one redraw of the rows on screen
   * per family that lands, once, at background priority.
   */
  fonts: z.string().nullable(),
  /**
   * Which colours the workspace's tag library declared when the picture was
   * drawn (`tagLibraryKey`), and NULL for markdown, which has no box to
   * colour. A spatial board's uncoloured boxes are drawn in the colour the
   * library declares for their tags, so without this axis an edit to the
   * library would leave every remembered picture — on disk, past the tab —
   * in a colour the workspace no longer declares.
   */
  library: z.string().nullable(),
  /**
   * What the documents this one embeds or links WERE when it was drawn
   * (`referencesKey`): '' when the picture was drawn with none supplied —
   * which is every document that names no other, so its key is the one it
   * had before this axis existed — and NULL when one of them came from a
   * keeper that cannot say what its content is.
   *
   * Null here means what a null `version` means, and for the same reason:
   * nothing to notice a change by, so the key is not memoisable. Both kinds
   * carry the axis, because a note embeds as surely as a board does — and
   * a note carrying it carries the theme, font and library axes too, since
   * what it embeds may be a board.
   */
  references: z.string().nullable(),
})

export type RenderKey = z.infer<typeof renderKeySchema>

/**
 * The document fields a key is built from.
 *
 * `kind` is `DocumentKind` rather than a hand-written copy of its members:
 * a parallel union beside the schema is the drift this repo's Zod discipline
 * exists to prevent, and here it would let a new kind be keyed as one of the
 * old ones.
 */
export interface RenderKeySubject {
  readonly documentId: string
  readonly kind: DocumentKind
  /**
   * The identity of the document's content at the moment it is drawn — a
   * list row's `contentDigest`, the open document's own content digest —
   * the same function, so a row and the document it lists share one entry.
   * Opaque, equality only. Absent when the keeper cannot say, and then
   * nothing may be memoised (`isMemoisableKey`).
   *
   * Not a timestamp, and it was one: `updatedAt` is a register one replica
   * wrote, and a merge does not consult it. Measured, a replica's content
   * took on a state nobody had written while its stamp stayed put — so the
   * memo kept answering the old picture under an unchanged key.
   */
  readonly state?: string
}

/**
 * The key for the SVG a surface draws at size — the expensive family.
 *
 * `fonts` is the caller's answer to "which theme faces could this realm
 * measure", `themeFacesKey()` for every surface that has one. Passed in
 * rather than read here, so this module stays the declared value type it
 * says it is and a test can key a picture without a face set.
 */
export function renderKeyOf(
  subject: RenderKeySubject,
  theme: ResolvedTheme,
  fonts: string,
  library: string,
  references: string | null = '',
): RenderKey {
  // A note that draws what it embeds may be drawing a board, and a board's
  // palette, faces and tag colours are baked into the picture wherever it is
  // drawn — so such a note is keyed on every axis a board is.
  const spatial = subject.kind === 'spatial' || references !== ''
  return {
    buildId: RENDERER_BUILD_ID,
    pipeline: 'svg',
    documentId: subject.documentId,
    kind: subject.kind,
    version: subject.state ?? null,
    // Baked into a spatial SVG's own bytes; a markdown one takes its ink
    // from page CSS, so one entry serves both themes.
    theme: spatial ? theme : null,
    // Same asymmetry, same reason: only a spatial picture can be drawn in a
    // family a theme names.
    fonts: spatial ? fonts : null,
    // And again: only a spatial picture has boxes a declaration colours.
    library: spatial ? library : null,
    references,
  }
}

/** Hex characters of the digest a library is keyed by: 64 bits, a bounded path segment. */
const LIBRARY_KEY_LENGTH = 16

/**
 * The `library` axis for a workspace's tag library: '' when it declares no
 * colour, so a workspace without one keys exactly like a library that is
 * absent, and otherwise a digest of the colours alone.
 *
 * Only the declared colours, because only they reach a picture: a key that
 * changed with a description would throw away every thumbnail for an edit
 * nobody can see. Sorted, because the library arrives in whatever order its
 * document was written and the same declarations must name one entry.
 * Hashed rather than spelled out, because the axis is a segment of a file
 * name in the worker's store and a library has no upper size.
 */
export async function tagLibraryKey(library: TagLibrary): Promise<string> {
  const declared: string[] = []
  for (const [key, declaration] of Object.entries(library)) {
    for (const [value, valueDeclaration] of Object.entries(declaration.values ?? {})) {
      if (valueDeclaration.color !== undefined) {
        declared.push(`${key}:${value}=${valueDeclaration.color}`)
      }
    }
  }
  return await digestKey(declared)
}

/**
 * '' for nothing, and otherwise a bounded digest of the lines in code-unit
 * order — the one canonical form both hashed axes share, so neither can key
 * the same content two ways.
 */
async function digestKey(lines: readonly string[]): Promise<string> {
  if (lines.length === 0) return ''
  const canonical = new TextEncoder().encode([...lines].sort(compareCodeUnit).join('\n'))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', canonical))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, LIBRARY_KEY_LENGTH)
}

/**
 * One reference a picture drew, as the key needs it: the target as written,
 * the document it resolved to (absent when it names nothing), that
 * document's content identity, and the label it was drawn under — or, for a
 * stored picture, the `image` it was drawn with: its `data:` URL, which is
 * its content, or '' when it was drawn as its card.
 */
export interface ReferenceKeyRow {
  readonly target: string
  readonly documentId?: string
  readonly version?: string
  readonly label?: string
  readonly image?: string
}

/**
 * The `references` axis: '' for a picture that draws no other document,
 * null when a resolved one has no content identity to notice a change by,
 * and otherwise a digest of every row.
 *
 * The label is in it because an embed is drawn under its document's name,
 * and a rename moves no content digest. A picture's href is in it because a
 * picture's bytes are what is drawn, and the reference names no version. A dangling target is a row too: it
 * is drawn as missing, and the day it resolves is a different picture.
 */
export async function referencesKey(rows: readonly ReferenceKeyRow[]): Promise<string | null> {
  const lines: string[] = []
  for (const row of rows) {
    if (row.documentId !== undefined && row.version === undefined) return null
    // `image` only when present, so a row naming a document keys as it did
    // before pictures had a row of their own.
    lines.push(
      JSON.stringify([
        row.target,
        row.documentId ?? null,
        row.version ?? null,
        row.label ?? null,
        ...(row.image === undefined ? [] : [row.image]),
      ]),
    )
  }
  return await digestKey(lines)
}

/**
 * The key for a document's OUTLINE — the rectangles a tree row's icon and
 * the tab favicon draw.
 *
 * It takes no theme, and that is the point rather than an omission: outline
 * colours are resolved from the light palette for both kinds, so a theme axis
 * would double the entries to hold identical rectangles and make a theme
 * toggle redraw every icon for nothing. A separate constructor rather than a
 * third argument, so no caller has to pass a theme that would be ignored.
 */
export function outlineKeyOf(subject: RenderKeySubject): RenderKey {
  return {
    buildId: RENDERER_BUILD_ID,
    pipeline: 'outline',
    documentId: subject.documentId,
    kind: subject.kind,
    version: subject.state ?? null,
    theme: null,
    // Nor a font axis, for the same kind of reason: a spatial outline is a
    // map over boxes the document already declares, and a markdown one is
    // measured in the bundled family. Neither changes when a theme's face
    // lands, so an axis would only double the entries.
    fonts: null,
    // An outline's rectangles carry a box's own colour only — the outline
    // request takes no library — so there is nothing for this axis to name.
    library: null,
    // Nor references: an outline maps the boxes a document declares, and an
    // embed's content never reaches it.
    references: '',
  }
}

/**
 * Whether a completed render may be remembered under this key.
 *
 * Only a key that can NOTICE a change may be: with `version: null` the key a
 * re-read produces is byte-identical to the one before it, so a memo would
 * answer with the old picture until the tab closes. A caller may still join
 * work already in flight for such a key — two panes asking in the same
 * instant are asking about the same bytes — which is why this is a property
 * of the memo and not of the whole broker.
 */
export function isMemoisableKey(key: RenderKey): boolean {
  return key.version !== null && key.references !== null
}

/**
 * The path a worker may store this answer under, or `undefined` when it may
 * not remember it at all.
 *
 * Derived from `isMemoisableKey` rather than decided again, so the in-memory
 * map and the persistent tier cannot disagree about which entries are safe.
 * They must not: an entry the map refuses because it could not notice its
 * document changing would, on disk, outlive the tab as well.
 */
export function cacheKeyFor(key: RenderKey): string | undefined {
  return isMemoisableKey(key) ? renderKeyPath(key) : undefined
}

/**
 * One path segment, unambiguous whatever the value contains.
 *
 * Both `documentId` and the version are opaque strings from a keeper — the
 * daemon's document contract says so explicitly and is deliberately not
 * pattern-bound — so a `/` in either would otherwise move the boundary
 * between segments and let two different documents join to one path.
 * `encodeURIComponent` is reversible and escapes the separator; the `~`
 * prefix is what makes `.` and `..` impossible as whole segments, which
 * matters before the OPFS store exists rather than after.
 */
function segment(value: string): string {
  return `~${encodeURIComponent(value)}`
}

/**
 * What a stored entry's bytes are — JSON for every family, and that is a
 * correction to this key's first sketch rather than an oversight.
 *
 * `.svg` was right while the entry was imagined as the picture alone. What a
 * caller actually needs back is the whole worker reply: an SVG AND the bounds
 * a consumer scales it to, or an outline's rectangles. Storing only the SVG
 * would mean re-deriving the extent by parsing its viewBox back out, to avoid
 * writing four numbers — and `layout`'s reply carries a `scene` and `anchors`
 * that are not optional on it, so an entry without them could not be served
 * back as one at all.
 *
 * The FAMILY is still named in the path, one segment up, which is what the
 * extension was carrying: a directory listing says `svg/` or `outline/`, and
 * a sweep can still drop one family the way it drops one build.
 */
const EXTENSION: Readonly<Record<BrokeredPipeline, string>> = {
  svg: 'json',
  outline: 'json',
}

/**
 * The key as a path, build id first (ADR-0027 decision 5).
 *
 * Today it is the in-memory map's key; it is shaped as a path because that is
 * what the OPFS store will address, and a leading build id makes retiring a
 * build's whole cache one directory removal rather than a scan.
 */
export function renderKeyPath(key: RenderKey): string {
  const version = key.version ?? ''
  // Every axis that is set, in one leaf. The font set is encoded like any
  // other opaque value: it is a comma-joined list of family names, and a
  // family may hold a separator.
  const leaf = [
    segment(version),
    ...(key.theme === null ? [] : [key.theme]),
    ...(key.fonts === null ? [] : [segment(key.fonts)]),
    ...(key.library === null ? [] : [segment(key.library)]),
    // Only when set, so a document that embeds nothing keeps the path it
    // had before the axis existed; the `r` names the segment, since a
    // markdown leaf has no theme or font segment to count from.
    ...(key.references === null || key.references === '' ? [] : [`r${segment(key.references)}`]),
  ].join('-')
  // The pipeline sits under the build id and above the kind, so a sweep can
  // drop one family the way it can already drop one build: a directory.
  return `${segment(key.buildId)}/${key.pipeline}/${key.kind}/${segment(key.documentId)}/${leaf}.${EXTENSION[key.pipeline]}`
}
