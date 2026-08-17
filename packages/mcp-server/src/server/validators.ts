import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { DOCUMENT_PATH_SEGMENT_PATTERN } from '@kamiazya/whiteboard-model'
import {
  isExternalUrlPolicyError,
  validateBrowserExternalUrl,
} from '../shared/external-url-policy.js'

// The path-segment rule itself is imported from model so the shared
// layer and this validator cannot drift apart; what stays here is only how a
// rejection is explained, which the schema's single message cannot do per
// cause.
const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_-]+$/
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_-]+$/
const SAFE_BRANCH_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/
const PRIVATE_ADDRESS_ERROR = 'Private or local addresses are not allowed in external URLs.'

const PRIVATE_ADDRESS_BLOCKLIST = new BlockList()
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('0.0.0.0', 8, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('10.0.0.0', 8, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('100.64.0.0', 10, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('127.0.0.0', 8, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('169.254.0.0', 16, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('172.16.0.0', 12, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('192.0.0.0', 24, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('192.0.2.0', 24, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('192.168.0.0', 16, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('198.18.0.0', 15, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('198.51.100.0', 24, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('203.0.113.0', 24, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('224.0.0.0', 4, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('240.0.0.0', 4, 'ipv4')
PRIVATE_ADDRESS_BLOCKLIST.addAddress('::', 'ipv6')
PRIVATE_ADDRESS_BLOCKLIST.addAddress('::1', 'ipv6')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('fc00::', 7, 'ipv6')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('fe80::', 10, 'ipv6')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('ff00::', 8, 'ipv6')
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('2001:db8::', 32, 'ipv6')

export class ValidationError extends Error {
  constructor(
    readonly error: string,
    message: string,
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

interface ExternalUrlLookupResult {
  address: string
  family: number
}

export interface ExternalUrlValidationOptions {
  lookup?: (hostname: string) => Promise<ExternalUrlLookupResult[]>
}

async function defaultExternalUrlLookup(
  targetHostname: string,
): Promise<ExternalUrlLookupResult[]> {
  return await dnsLookup(targetHostname, { all: true, verbatim: true })
}

const externalUrlLookup = defaultExternalUrlLookup

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

function normalizePotentialIpv4MappedIpv6(address: string): string {
  const lowered = address.toLowerCase()
  if (!lowered.startsWith('::ffff:')) return lowered
  const mapped = lowered.slice('::ffff:'.length)
  return isIP(mapped) === 4 ? mapped : lowered
}

function isPrivateOrLocalIp(address: string, family?: number): boolean {
  const normalized = normalizePotentialIpv4MappedIpv6(address)
  const ipVersion = family ?? isIP(normalized)
  if (ipVersion !== 4 && ipVersion !== 6) return true
  return PRIVATE_ADDRESS_BLOCKLIST.check(normalized, ipVersion === 6 ? 'ipv6' : 'ipv4')
}

function rejectPrivateOrLocalAddress(): never {
  throw new ValidationError('invalid_url', PRIVATE_ADDRESS_ERROR)
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

export function validateBranchName(name: string): string {
  if (name === '') {
    throw new ValidationError('invalid_branch_name', 'Invalid branch name: empty')
  }
  if (name.includes('/')) {
    throw new ValidationError(
      'invalid_branch_name',
      `Invalid branch name "${name}": "/" is not allowed`,
    )
  }
  if (!SAFE_BRANCH_NAME.test(name)) {
    throw new ValidationError(
      'invalid_branch_name',
      `Invalid branch name "${name}": kebab-case ASCII only`,
    )
  }
  // The UI renders exactly 'main' as 'Main' for display. Allowing a
  // case-variant like 'Main' or 'MAIN' as a real branch name would make it
  // render identically to (and thus indistinguishable from) the default
  // branch across switch/rename/delete/combine surfaces.
  if (name !== 'main' && name.toLowerCase() === 'main') {
    throw new ValidationError(
      'invalid_branch_name',
      `Invalid branch name "${name}": reserved (conflicts with "main")`,
    )
  }
  return name
}

export function validateCanvasId(id: string): string {
  return validateSafeIdentifier(id, 'canvas id')
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

export async function validateExternalUrl(
  rawUrl: string,
  options: ExternalUrlValidationOptions = {},
): Promise<URL> {
  try {
    const url = validateBrowserExternalUrl(rawUrl)
    const hostname = url.hostname.toLowerCase()
    const literalFamily = isIP(hostname)
    if (literalFamily !== 0) {
      if (isPrivateOrLocalIp(hostname, literalFamily)) {
        rejectPrivateOrLocalAddress()
      }
      return url
    }

    const lookup = options.lookup ?? externalUrlLookup

    let results: ExternalUrlLookupResult[]
    try {
      results = await lookup(hostname)
    } catch {
      throw new ValidationError(
        'invalid_url',
        `Failed to resolve external URL hostname "${hostname}".`,
      )
    }

    if (results.length === 0) {
      throw new ValidationError(
        'invalid_url',
        `Failed to resolve external URL hostname "${hostname}".`,
      )
    }

    if (results.some((result) => isPrivateOrLocalIp(result.address, result.family))) {
      rejectPrivateOrLocalAddress()
    }

    return url
  } catch (error) {
    if (isExternalUrlPolicyError(error)) {
      throw new ValidationError('invalid_url', error.message)
    }
    throw error
  }
}
