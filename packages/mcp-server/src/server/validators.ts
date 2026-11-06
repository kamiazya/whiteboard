import {
  DOCUMENT_PATH_MAX_LENGTH,
  DOCUMENT_PATH_SEGMENT_PATTERN,
  PATH_SAFE_ID_PATTERN,
  workspaceCanonicalIdSchema,
  workspaceSegmentSchema,
} from '@kamiazya/whiteboard-model'

// The path-segment, id and workspace rules themselves are imported from model
// so the shared layer and this validator cannot drift apart; what stays here
// is only how a rejection is explained, which the schema's single message
// cannot do per cause.
export class ValidationError extends Error {
  constructor(
    readonly error: string,
    message: string,
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

function diagnosePathSegment(segment: string): string | null {
  if (segment === '') {
    return 'empty segment (leading/trailing/consecutive "/" are not allowed)'
  }
  if (/\s/.test(segment)) return 'contains whitespace'
  if (segment.includes('.')) {
    return `contains '.' (only letters, digits, and '-' are allowed)`
  }
  if (segment.startsWith('-')) return 'leading hyphen is not allowed'
  if (segment.endsWith('-')) return 'trailing hyphen is not allowed'
  if (!DOCUMENT_PATH_SEGMENT_PATTERN.test(segment)) {
    return 'contains invalid character (only ASCII letters, digits, and "-" are allowed)'
  }
  return null
}

function validateSafeIdentifier(value: string, kind: string, maxLength = 64): string {
  if (!PATH_SAFE_ID_PATTERN.test(value)) {
    throw new ValidationError(
      `invalid_${kind.replace(/\s+/g, '_')}`,
      `Invalid ${kind} "${value}": must match ${PATH_SAFE_ID_PATTERN}`,
    )
  }
  if (value.length > maxLength) {
    throw new ValidationError(
      `invalid_${kind.replace(/\s+/g, '_')}`,
      `Invalid ${kind} "${value}": exceeds ${maxLength} character limit`,
    )
  }
  return value
}

/**
 * A workspace's canonical id, as every store, row and on-disk directory keys
 * one. Anything else — `default`, a nanoid carrying `_` — is an id from before
 * the re-key onto ULIDs and is refused rather than read.
 */
export function validateWorkspaceId(workspaceId: string): string {
  if (workspaceId === '') {
    throw new ValidationError('invalid_workspace_id', 'Invalid workspaceId: workspaceId is empty')
  }
  if (!workspaceCanonicalIdSchema.safeParse(workspaceId).success) {
    throw new ValidationError(
      'invalid_workspace_id',
      `Invalid workspaceId "${workspaceId}": a workspace id is a canonical ULID`,
    )
  }
  return workspaceId
}

/**
 * The workspace handle one URL path component carries before it is resolved:
 * the canonical id or a segment in the caller's namespace (ADR-0053). Both
 * grammars keep `.`, `/`, whitespace and non-ASCII out, which is what makes a
 * refused handle safe to echo and an accepted one safe to look up.
 */
export function validateWorkspaceHandle(handle: string): string {
  if (handle === '') {
    throw new ValidationError('invalid_workspace_id', 'Invalid workspaceId: workspaceId is empty')
  }
  if (
    !workspaceCanonicalIdSchema.safeParse(handle).success &&
    !workspaceSegmentSchema.safeParse(handle).success
  ) {
    throw new ValidationError(
      'invalid_workspace_id',
      `Invalid workspaceId "${handle}": a workspace is addressed by its canonical id or by a segment (ASCII letters, digits and interior hyphens)`,
    )
  }
  return handle
}

export function validateDocumentPath(path: string): string {
  if (path === '') {
    throw new ValidationError('invalid_document_path', 'Invalid path: path is empty')
  }
  if (path.length > DOCUMENT_PATH_MAX_LENGTH) {
    throw new ValidationError(
      'invalid_document_path',
      `Invalid path: path is ${path.length} characters, past the ${DOCUMENT_PATH_MAX_LENGTH}-character limit`,
    )
  }
  for (const segment of path.split('/')) {
    const reason = diagnosePathSegment(segment)
    if (reason !== null) {
      throw new ValidationError(
        'invalid_document_path',
        `Invalid path "${path}": segment "${segment}" ${reason}`,
      )
    }
  }
  return path
}

export function validateVersionId(id: string): string {
  return validateSafeIdentifier(id, 'version id')
}

export function validateFileId(id: string): string {
  return validateSafeIdentifier(id, 'file id', 128)
}

function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError
}

export function validationErrorBody(error: unknown): { error: string; message: string } | null {
  if (!isValidationError(error)) return null
  return { error: error.error, message: error.message }
}
