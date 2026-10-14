import { z } from 'zod'

/**
 * What a batch of agent edits touched, by kind — declared ONCE, here, and
 * read on both sides of the wire: `AgentActivity['touched']` (the
 * `CanvasClientNotifier` port) is its `z.infer`, and daemon-client's
 * `agent_activity` frame reuses it. Two declarations joined by a mapper that
 * copied each kind by name let a kind added on the server reach every tool
 * and still be dropped on the way to the browser's outline, with the
 * compiler silent.
 *
 * Ids only — the change itself arrives as a Loro update.
 */
export const agentActivityTouchedSchema = z.object({
  nodes: z.array(z.string()),
  edges: z.array(z.string()),
  lines: z.array(z.string()),
  comments: z.array(z.string()),
})

export type AgentActivityTouched = z.infer<typeof agentActivityTouchedSchema>
