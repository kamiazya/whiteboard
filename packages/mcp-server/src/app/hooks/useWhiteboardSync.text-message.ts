import {
  type ExportRequestMessage,
  type HeadChangedMessage,
  type OperatorInfo,
  type RestoreCompleteMessage,
  type RestoreStartedMessage,
  type ServerTextMessage,
  serverTextMessageSchema,
  type VersionCreatedMessage,
  type VersionCreatedPayload,
  type ViewportRequestMessage,
} from '../../shared/ws-messages.js'

// Re-export the shared types that the React hook + tests still import from
// this module so the call sites don't have to learn a new path.
export type {
  ExportRequestMessage,
  HeadChangedMessage,
  OperatorInfo,
  RestoreCompleteMessage,
  RestoreStartedMessage,
  ServerTextMessage,
  VersionCreatedMessage,
  VersionCreatedPayload,
  ViewportRequestMessage,
}

export function parseServerTextMessage(
  raw: string,
  warn: (...args: unknown[]) => void = console.warn,
): ServerTextMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn('[whiteboard] ignored invalid server text message:', 'malformed JSON', raw)
    return null
  }
  const result = serverTextMessageSchema.safeParse(parsed)
  if (!result.success) {
    warn(
      '[whiteboard] ignored invalid server text message:',
      result.error.issues[0]?.message ?? 'schema mismatch',
      parsed,
    )
    return null
  }
  return result.data
}
