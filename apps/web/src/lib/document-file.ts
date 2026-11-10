/**
 * The document itself, as the file a person keeps: a note as OKF Markdown and
 * a canvas as extended JSON Canvas. The picture exports (`document-export.ts`)
 * are lossy renderings; these are the sources they are drawn from, and
 * `document-import.ts` reads them back.
 */

import {
  type OkfMarkdownFrontmatter,
  serializeOkf,
  serializeSpatial,
} from '@kamiazya/whiteboard-codec'
import type { ExtensionFacets, SpatialCanvas, StoredCoreFacets } from '@kamiazya/whiteboard-model'
import { codecsReady } from './codec-cores.js'

/** What a markdown document with no declared type is taken to be. */
const BARE_BODY_TYPE = 'note'

export interface MarkdownDocumentFileInput {
  readonly body: string
  /** The workspace's display name; becomes the frontmatter `title`. */
  readonly name: string | null | undefined
  readonly coreFacets: StoredCoreFacets | undefined
  readonly facets: ExtensionFacets
}

/**
 * The title is a projection of the workspace name, never stored content, so
 * an unnamed document writes none rather than borrowing its path.
 */
export async function markdownDocumentFile(input: MarkdownDocumentFileInput): Promise<Blob> {
  const frontmatter: OkfMarkdownFrontmatter = {
    ...(input.coreFacets ?? { type: BARE_BODY_TYPE }),
    ...(input.name ? { title: input.name } : {}),
    facets: input.facets,
  }
  await codecsReady()
  const markdown = serializeOkf({ frontmatter, body: input.body })
  return new Blob([markdown], { type: 'text/markdown' })
}

/** An image is written as an `asset:` reference to the workspace's file, not as bytes. */
export async function spatialDocumentFile(canvas: SpatialCanvas): Promise<Blob> {
  await codecsReady()
  return new Blob([serializeSpatial(canvas, 'extended')], { type: 'application/json' })
}
