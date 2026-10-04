import {
  DOCUMENT_PATH_MAX_LENGTH,
  DOCUMENT_PATH_SEGMENT_PATTERN,
  WORKSPACE_ID_PATTERN,
} from '@kamiazya/whiteboard-model'

// The path-segment and workspace-id rules themselves are imported from model so
// the shared layer and this validator cannot drift apart; what stays here is
// only how a rejection is explained, which the schema's single message cannot
// do per cause.
//
// Version and file ids are not workspace ids, but they are used the same way
// (directly as path segments and keys), so they take the same character class
// by choice rather than by sharing a concept; the alias names that choice so
// loosening one is a decision, not an accident.
const SAFE_IDENTIFIER = WORKSPACE_ID_PATTERN
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
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new ValidationError(
      `invalid_${kind.replace(/\s+/g, '_')}`,
      `Invalid ${kind} "${value}": must match ${SAFE_IDENTIFIER}`,
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

export function validateWorkspaceId(workspaceId: string): string {
  if (workspaceId === '') {
    throw new ValidationError('invalid_workspace_id', 'Invalid workspaceId: workspaceId is empty')
  }
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new ValidationError(
      'invalid_workspace_id',
      `Invalid workspaceId "${workspaceId}": only ASCII letters, digits, "_" and "-" are allowed`,
    )
  }
  return workspaceId
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
