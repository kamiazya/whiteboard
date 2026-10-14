/**
 * The `/api/v1` request BODIES a client sends, derived from the tool input
 * each route parses them with. A route merges the keys its URL carries into
 * the body before the `.strict()` parse, so a body type is that input minus
 * exactly those keys — a client that sent one would be refused, and a client
 * missing a key the route does not supply now fails to compile.
 */

import type {
  linkifyMentionsInputSchema,
  wbDocumentCreateInputSchema,
} from '@kamiazya/whiteboard-server-core/contracts'
import type { z } from 'zod'

/** `Omit` applied per member, so each branch of a discriminated union keeps its own keys. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** `POST /api/v1/workspaces/:workspaceId/documents` — the workspace comes from the path. */
export type CreateDocumentV1Request = OmitEach<
  z.input<typeof wbDocumentCreateInputSchema>,
  'workspaceId'
>

/**
 * `POST /api/v1/workspaces/:workspaceId/documents/:documentId/linkify-mentions`
 * — the workspace and the SOURCE document come from the path.
 */
export type LinkifyMentionsV1Request = Omit<
  z.input<typeof linkifyMentionsInputSchema>,
  'workspaceId' | 'documentId'
>
