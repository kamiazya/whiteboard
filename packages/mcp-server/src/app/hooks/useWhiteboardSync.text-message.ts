import type { ExportRequestMessage } from './useWhiteboardSync.helpers.js'

export interface OperatorInfo {
  kind: 'ai' | 'human' | 'system'
  peerId: string
  displayName?: string
  agentId?: string
  workspaceId?: string
}

export interface VersionCreatedPayload {
  id: string
  slug: string
  createdAt: string
  elementCount: number
  auto: boolean
  label?: string
  hasThumbnail: boolean
  operator?: OperatorInfo
}

export interface RestoreStartedMessage {
  type: 'restore_started'
  label?: string
}

export interface RestoreCompleteMessage {
  type: 'restore_complete'
}

export interface ViewportRequestMessage {
  type: 'viewport_request'
  requestId: string
  mode?: 'fit' | 'move'
  elementIds?: string[]
  animate?: boolean
  scrollX?: number
  scrollY?: number
  zoom?: number
}

export interface VersionCreatedMessage {
  type: 'version_created'
  version: VersionCreatedPayload
}

// Signal that HEAD switching finished. The UI uses this to refresh branch state.
export interface HeadChangedMessage {
  type: 'head_changed'
  head: string
}

export type ServerTextMessage =
  | ExportRequestMessage
  | RestoreStartedMessage
  | RestoreCompleteMessage
  | ViewportRequestMessage
  | VersionCreatedMessage
  | HeadChangedMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOperatorInfo(value: unknown): value is OperatorInfo {
  if (!isRecord(value)) return false
  if (value.kind !== 'ai' && value.kind !== 'human' && value.kind !== 'system') return false
  if (typeof value.peerId !== 'string' || value.peerId.length === 0) return false
  if (value.displayName !== undefined && typeof value.displayName !== 'string') return false
  if (value.agentId !== undefined && typeof value.agentId !== 'string') return false
  if (value.workspaceId !== undefined && typeof value.workspaceId !== 'string') return false
  return true
}

function isVersionCreatedPayload(value: unknown): value is VersionCreatedPayload {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string') return false
  if (typeof value.slug !== 'string') return false
  if (typeof value.createdAt !== 'string') return false
  if (!isFiniteNumber(value.elementCount)) return false
  if (typeof value.auto !== 'boolean') return false
  if (value.label !== undefined && typeof value.label !== 'string') return false
  if (typeof value.hasThumbnail !== 'boolean') return false
  if (value.operator !== undefined && !isOperatorInfo(value.operator)) return false
  return true
}

function warnInvalidMessage(
  warn: (...args: unknown[]) => void,
  reason: string,
  payload: unknown,
): null {
  warn('[whiteboard] ignored invalid server text message:', reason, payload)
  return null
}

export function parseServerTextMessage(
  raw: string,
  warn: (...args: unknown[]) => void = console.warn,
): ServerTextMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return warnInvalidMessage(warn, 'malformed JSON', raw)
  }

  if (!isRecord(parsed)) {
    return warnInvalidMessage(warn, 'payload must be an object', parsed)
  }

  const type = parsed.type
  if (typeof type !== 'string') {
    return warnInvalidMessage(warn, 'missing type', parsed)
  }

  if (type === 'version_created') {
    if (!isVersionCreatedPayload(parsed.version)) {
      return warnInvalidMessage(warn, 'invalid version_created payload', parsed)
    }
    return { type, version: parsed.version }
  }

  if (type === 'restore_started') {
    if (parsed.label !== undefined && typeof parsed.label !== 'string') {
      return warnInvalidMessage(warn, 'invalid restore_started payload', parsed)
    }
    return parsed.label !== undefined ? { type, label: parsed.label } : { type }
  }

  if (type === 'restore_complete') {
    return { type }
  }

  if (type === 'head_changed') {
    if (typeof parsed.head !== 'string' || parsed.head.length === 0) {
      return warnInvalidMessage(warn, 'head_changed requires head (string)', parsed)
    }
    return { type, head: parsed.head }
  }

  if (type === 'viewport_request') {
    if (typeof parsed.requestId !== 'string') {
      return warnInvalidMessage(warn, 'viewport_request requires requestId', parsed)
    }
    if (parsed.mode !== undefined && parsed.mode !== 'fit' && parsed.mode !== 'move') {
      return warnInvalidMessage(warn, 'viewport_request has invalid mode', parsed)
    }
    if (parsed.elementIds !== undefined && !isStringArray(parsed.elementIds)) {
      return warnInvalidMessage(warn, 'viewport_request has invalid elementIds', parsed)
    }
    if (parsed.animate !== undefined && typeof parsed.animate !== 'boolean') {
      return warnInvalidMessage(warn, 'viewport_request has invalid animate', parsed)
    }
    if (parsed.scrollX !== undefined && !isFiniteNumber(parsed.scrollX)) {
      return warnInvalidMessage(warn, 'viewport_request has invalid scrollX', parsed)
    }
    if (parsed.scrollY !== undefined && !isFiniteNumber(parsed.scrollY)) {
      return warnInvalidMessage(warn, 'viewport_request has invalid scrollY', parsed)
    }
    if (parsed.zoom !== undefined && !isFiniteNumber(parsed.zoom)) {
      return warnInvalidMessage(warn, 'viewport_request has invalid zoom', parsed)
    }
    return {
      type,
      requestId: parsed.requestId,
      ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      ...(parsed.elementIds !== undefined ? { elementIds: parsed.elementIds } : {}),
      ...(parsed.animate !== undefined ? { animate: parsed.animate } : {}),
      ...(parsed.scrollX !== undefined ? { scrollX: parsed.scrollX } : {}),
      ...(parsed.scrollY !== undefined ? { scrollY: parsed.scrollY } : {}),
      ...(parsed.zoom !== undefined ? { zoom: parsed.zoom } : {}),
    }
  }

  if (type === 'export_request') {
    if (typeof parsed.requestId !== 'string') {
      return warnInvalidMessage(warn, 'export_request requires requestId', parsed)
    }
    if (parsed.padding !== undefined && !isFiniteNumber(parsed.padding)) {
      return warnInvalidMessage(warn, 'export_request has invalid padding', parsed)
    }
    if (parsed.scale !== undefined && !isFiniteNumber(parsed.scale)) {
      return warnInvalidMessage(warn, 'export_request has invalid scale', parsed)
    }
    if (parsed.minFontPx !== undefined && !isFiniteNumber(parsed.minFontPx)) {
      return warnInvalidMessage(warn, 'export_request has invalid minFontPx', parsed)
    }
    if (parsed.frameId !== undefined && typeof parsed.frameId !== 'string') {
      return warnInvalidMessage(warn, 'export_request has invalid frameId', parsed)
    }
    return {
      type,
      requestId: parsed.requestId,
      ...(parsed.padding !== undefined ? { padding: parsed.padding } : {}),
      ...(parsed.scale !== undefined ? { scale: parsed.scale } : {}),
      ...(parsed.minFontPx !== undefined ? { minFontPx: parsed.minFontPx } : {}),
      ...(parsed.frameId !== undefined ? { frameId: parsed.frameId } : {}),
    }
  }

  return warnInvalidMessage(warn, `unknown type "${type}"`, parsed)
}
