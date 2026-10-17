import { workspaceAddressInputSchema } from '@kamiazya/whiteboard-model'

/**
 * Every tool's `workspaceId` (ADR-0053): one schema and one sentence, so the
 * three forms read the same on every tool and the next tool gets them for
 * free. A bare segment is relative to the CALLER — safe in an argument, which
 * is never handed to someone else the way a link is.
 */
export const workspaceAddressArgSchema = workspaceAddressInputSchema.describe(
  'Workspace id, <handle>/<segment>, or a segment of your own.',
)
