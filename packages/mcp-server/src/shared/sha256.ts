import { createHash } from 'node:crypto'

/**
 * The lowercase-hex SHA-256 of some bytes or a string (UTF-8). One spelling
 * for the daemon's content addresses and its stored token hashes, so a digest
 * computed in one module is the digest another looks up by.
 */
export function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex')
}
