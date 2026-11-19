import {
  applyDocumentEdit,
  type ContentWithTags,
  type DocumentContainers,
  readContentWithTags,
  readDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { extractContentFacts } from '../extract.js'
import { planLinkifyMentions } from '../linkify.js'
import { planDocumentReferenceRewrite } from '../rewrite.js'

/**
 * The keeper's half of a plan, for tests that hold a document: read the
 * content, plan, apply. What a test asserts through it is the document after
 * the edit, which is what a keeper's own save carries.
 */
export function linkifyInPlace(
  doc: DocumentContainers,
  kind: DocumentKind | undefined,
  target: Parameters<typeof planLinkifyMentions>[1],
): number {
  const { linked, edit } = planLinkifyMentions(readDocumentContent(doc, kind), target)
  if (edit !== null) applyDocumentEdit(doc, edit)
  return linked
}

export function rewriteInPlace(
  doc: DocumentContainers,
  plan: ReadonlyMap<string, string>,
  kind: DocumentKind | undefined,
): boolean {
  const edit = planDocumentReferenceRewrite(readDocumentContent(doc, kind), plan)
  if (edit === null) return false
  applyDocumentEdit(doc, edit)
  return true
}

export function loaded(doc: DocumentContainers, kind: DocumentKind | undefined): ContentWithTags {
  return readContentWithTags(doc, kind)
}

export function factsOf(doc: DocumentContainers, kind: DocumentKind | undefined) {
  return extractContentFacts(loaded(doc, kind))
}
