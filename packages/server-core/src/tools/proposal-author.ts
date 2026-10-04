import { okfActorSchema } from '@kamiazya/whiteboard-model'

/**
 * The `author` a proposing call may name, one declaration for both tools that
 * propose so a model learns one convention. The field and its schema are
 * `wb_thread_edit`'s: server-core carries no operator identity, so who is
 * speaking is the caller's to say.
 */
export const proposalAuthorSchema = okfActorSchema
  .optional()
  .describe(
    'Who is proposing, e.g. "claude-code/1.0". Set when this call opens the proposal; a call continuing one (proposalId) keeps its existing author.',
  )
