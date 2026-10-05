import { z } from 'zod'

/**
 * The codes a keeper answers a sync write it refused for what its bytes
 * would do — server-core's `syncWriteAnswer`, on every sync route. A
 * narrowing of `apiErrorBodySchema`'s `{ error, message }` arm, so a client
 * can tell the person WHICH limit their change broke rather than that
 * something failed.
 */
const syncWriteRefusalCodeSchema = z.enum([
  'markdown_too_large',
  'node_text_too_large',
  'label_too_large',
  'comment_too_large',
  'unreadable_document_meta',
  'document_name_too_long',
  'invalid_path',
])
export type SyncWriteRefusalCode = z.infer<typeof syncWriteRefusalCodeSchema>

/** A refusal body as the sync routes write it. */
const syncWriteRefusalBodySchema = z.object({
  error: syncWriteRefusalCodeSchema,
  message: z.string().min(1),
})

/**
 * What a client holds of a refused sync write, on its way to the person.
 * `code` is `null` for a refusal this client does not know — a newer keeper's,
 * or one answered outside the family — which is still a refusal: `message`
 * then carries the keeper's own sentence, when it gave one.
 */
export const syncWriteRefusalSchema = z.object({
  code: syncWriteRefusalCodeSchema.nullable(),
  message: z.string(),
})
export type SyncWriteRefusal = z.infer<typeof syncWriteRefusalSchema>

/**
 * Whether an answer to a sync write says the same bytes can never be taken.
 * A 4xx is about the request, so sending it again gets the same answer —
 * except a refused credential (401/403), which a new session clears and the
 * caller reports on its own path, and the two that ask for a retry by name
 * (408, 429). A 5xx is the keeper's own trouble, and a retry may land.
 */
export function isPermanentWriteRefusal(status: number): boolean {
  if (status < 400 || status >= 500) return false
  return status !== 401 && status !== 403 && status !== 408 && status !== 429
}

/** The refusal a body states, read through the sync routes' own contract. */
export function syncWriteRefusalOf(body: unknown): SyncWriteRefusal {
  const parsed = syncWriteRefusalBodySchema.safeParse(body)
  if (parsed.success) return { code: parsed.data.error, message: parsed.data.message }
  const message = z.object({ message: z.string() }).safeParse(body)
  return { code: null, message: message.success ? message.data.message : '' }
}

/**
 * A sync write the keeper answered with a permanent refusal. Thrown by a
 * push that talks to the keeper itself, so its caller can stop offering the
 * bytes and take the keeper's state instead of retrying them forever.
 */
export class SyncWriteRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly refusal: SyncWriteRefusal,
  ) {
    const code = refusal.code === null ? '' : ` ${refusal.code}`
    super(`update refused: ${status}${code}`)
    this.name = 'SyncWriteRefusedError'
  }
}
