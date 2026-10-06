import { z } from 'zod'

/**
 * The codes a keeper answers a sync write it refused for what its bytes would
 * do — one per bound the write broke. Declared once, here, because both sides
 * of the wire and both keepers spell them: the daemon's refusals are typed by
 * this enum, the client's contract parses with it, and the browser keeper
 * answers the same breach with the same code. A spelling held in two places
 * drifts without failing anything, since each side's tests pin only its own.
 */
export const syncWriteRefusalCodeSchema = z.enum([
  'markdown_too_large',
  'node_text_too_large',
  'node_location_too_large',
  'label_too_large',
  'comment_too_large',
  'tags_too_large',
  'container_name_too_long',
  'unreadable_document_meta',
  'document_name_too_long',
  'invalid_path',
])
export type SyncWriteRefusalCode = z.infer<typeof syncWriteRefusalCodeSchema>
