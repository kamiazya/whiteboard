/**
 * A file a person brings in, read into the document it would become.
 *
 * Reading is total: a file that cannot be a document answers a reason the
 * caller can show, because the picker and a drop both hand over whatever the
 * person had, and a throw here would be a blank screen at the one moment they
 * are watching. Writing the document is the keeper's (`WorkspaceFilesSource.
 * importDocument`); this only decides WHAT is written and WHERE it is named.
 */

import { parseOkf, parseSpatial } from '@kamiazya/whiteboard-codec'
import type { ExtensionFacets, SpatialCanvas, StoredCoreFacets } from '@kamiazya/whiteboard-model'
import { pathBelow } from '@kamiazya/whiteboard-model'

/** The `accept` of the file picker, and the extensions a drop is checked against. */
export const IMPORT_ACCEPT = '.md,.markdown,.canvas,.json'

const IMPORT_ACCEPTED_LABEL = '.md, .markdown, .canvas or .json'

interface ImportedBase {
  /** What the document is called; absent leaves the keeper to fall back to the path. */
  readonly name: string | undefined
  /** The path's last segment before the keeper resolves a collision. */
  readonly pathBase: string
}

export type ImportedDocument =
  | (ImportedBase & {
      readonly kind: 'markdown'
      readonly body: string
      readonly coreFacets: StoredCoreFacets
      readonly facets: ExtensionFacets
    })
  | (ImportedBase & { readonly kind: 'spatial'; readonly canvas: SpatialCanvas })

export type ImportResult =
  | { readonly ok: true; readonly document: ImportedDocument }
  | { readonly ok: false; readonly reason: string }

const EXTENSION = /\.([^./]+)$/

function extensionOf(fileName: string): string {
  return `.${EXTENSION.exec(fileName)?.[1]?.toLowerCase() ?? ''}`
}

function isImportableName(fileName: string): boolean {
  return IMPORT_ACCEPT.split(',').includes(extensionOf(fileName))
}

/** `Trip Plan.v2.md` -> `Trip Plan.v2`. */
function stemOf(fileName: string): string {
  return fileName.replace(EXTENSION, '')
}

/**
 * A path segment holds ASCII letters, digits and interior hyphens only, so
 * everything else collapses to a hyphen — the name a person sees is the
 * document's `name`, which keeps the file's own spelling.
 */
function pathBaseOf(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function refused(fileName: string, detail: string): ImportResult {
  return { ok: false, reason: `${fileName} could not be imported: ${detail}` }
}

export function readImportedFile(fileName: string, text: string): ImportResult {
  const extension = extensionOf(fileName)
  if (!isImportableName(fileName)) {
    return {
      ok: false,
      reason: `${fileName} is not a file this can import. Accepted: ${IMPORT_ACCEPTED_LABEL}.`,
    }
  }
  const stem = stemOf(fileName)
  const pathBase = pathBaseOf(stem)
  if (extension === '.canvas' || extension === '.json') {
    const parsed = parseSpatial(text)
    if (!parsed.ok) return refused(fileName, `not valid JSON Canvas (${parsed.error.message})`)
    return { ok: true, document: { kind: 'spatial', canvas: parsed.value, name: stem, pathBase } }
  }
  // Plain markdown is the common file; OKF's frontmatter is optional for the
  // person bringing it, so a body with none is a note rather than a refusal.
  if (!/^---\r?\n/.test(text)) {
    return {
      ok: true,
      document: {
        kind: 'markdown',
        body: text,
        coreFacets: { type: 'note' },
        facets: {},
        name: stem,
        pathBase,
      },
    }
  }
  const parsed = parseOkf(text)
  if (!parsed.ok) return refused(fileName, `unreadable frontmatter (${parsed.error.message})`)
  // The title is the workspace's name, projected back on export, never held
  // twice; the trust family has its own bucket the import does not write.
  const { title, facets, generated: _g, verified: _v, ...core } = parsed.value.frontmatter
  return {
    ok: true,
    document: {
      kind: 'markdown',
      body: parsed.value.body,
      coreFacets: core,
      facets: facets ?? {},
      name: title?.trim() ? title.trim() : stem,
      pathBase,
    },
  }
}

/**
 * The path for an imported file: its name inside `folder`, suffixed `-2`,
 * `-3` … past a sibling that holds it — the numbering a new document uses.
 */
export function importPathIn(
  folder: string,
  base: string,
  existingPaths: readonly string[],
): string {
  const stem = base === '' ? 'untitled' : base
  const prefix = folder === '' ? '' : `${folder}/`
  const siblings = new Set(
    existingPaths.flatMap((path) => {
      const rest = pathBelow(folder, path)
      return rest === undefined ? [] : [rest]
    }),
  )
  if (!siblings.has(stem)) return `${prefix}${stem}`
  let n = 2
  while (siblings.has(`${stem}-${n}`)) n++
  return `${prefix}${stem}-${n}`
}
