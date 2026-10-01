import { DOCUMENT_PATH_SEGMENT_PATTERN } from '@kamiazya/whiteboard-model'

// The path-segment rule itself is imported from model so the shared
// layer and this validator cannot drift apart; what stays here is only how a
// rejection is explained, which the schema's single message cannot do per
// cause.
const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_-]+$/
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_-]+$/
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
      `Invalid ${kind} "${value}": must match /^[a-zA-Z0-9_-]+$/`,
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
  if (!SAFE_WORKSPACE_ID.test(workspaceId)) {
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
