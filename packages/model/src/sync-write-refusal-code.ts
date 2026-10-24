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
  'comment_anchor_too_large',
  'anchor_quote_too_long',
  'tags_too_large',
  'container_name_too_long',
  'too_many_nodes_or_edges',
  'too_many_open_threads',
  'too_many_open_changes',
  'too_many_thread_messages',
  'unreadable_document_meta',
  'invalid_document_root',
  'reserved_map_key',
  'document_kind_changed',
  'document_name_too_long',
  'folder_name_refused',
  'invalid_path',
  'too_many_documents',
  'too_many_folders',
  'causal_gap',
])
export type SyncWriteRefusalCode = z.infer<typeof syncWriteRefusalCodeSchema>
