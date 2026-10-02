import {
  backlinksOutputSchema,
  documentSearchOutputSchema,
  documentTagsOutputSchema,
  exportOkfOutputSchema,
  linkifyMentionsOutputSchema,
  wbDocumentCreateOutputSchema,
} from '@kamiazya/whiteboard-server-core/contracts'
import type { z } from 'zod'
import { tolerantAnswer } from './tolerant-answer.js'

/**
 * The `/api/v1` answers the browser parses, each derived from the MCP tool
 * output the route serves so there is one definition of what a field is —
 * and tolerant of a field a newer daemon has added (`tolerantAnswer`). The
 * tool output itself stays strict for the SDK's check of what a handler
 * returned; a browser must not inherit that, or a document that WAS created
 * reads as "Response failed schema validation" on an older cached bundle.
 */
export const documentBacklinksResponseSchema = tolerantAnswer(backlinksOutputSchema)
export const documentSearchResponseSchema = tolerantAnswer(documentSearchOutputSchema)
export const workspaceDocumentTagsResponseSchema = tolerantAnswer(documentTagsOutputSchema)
export const documentOkfV1ResponseSchema = tolerantAnswer(exportOkfOutputSchema)
export const linkifyMentionsResponseSchema = tolerantAnswer(linkifyMentionsOutputSchema)
export const createDocumentV1ResponseSchema = tolerantAnswer(wbDocumentCreateOutputSchema)

export type DocumentBacklinksResponse = z.infer<typeof documentBacklinksResponseSchema>
export type DocumentSearchResponse = z.infer<typeof documentSearchResponseSchema>
export type WorkspaceDocumentTagsResponse = z.infer<typeof workspaceDocumentTagsResponseSchema>
export type DocumentOkfV1Response = z.infer<typeof documentOkfV1ResponseSchema>
export type LinkifyMentionsResponse = z.infer<typeof linkifyMentionsResponseSchema>
