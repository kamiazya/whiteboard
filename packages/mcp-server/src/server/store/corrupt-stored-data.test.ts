import { describe, expect, it } from 'vitest'
import { corruptStoredData } from './corrupt-stored-data.js'

describe('corruptStoredData', () => {
  it('defaults to phrasing the argument as a real file location', () => {
    const error = corruptStoredData('/tmp/blobs/ws/document/doc.loro', 'bad bytes')
    expect(error.message).toBe(
      'Stored data at "/tmp/blobs/ws/document/doc.loro" is corrupt: bad bytes',
    )
  })

  // Canvas snapshots now live in Libsql rows, not at the FS path
  // documentBlobPath() still computes for identity purposes — the message
  // must not tell an operator to go looking for a file that no longer
  // exists there.
  it('phrases an identity-only label without claiming it is a file location', () => {
    const error = corruptStoredData('/tmp/blobs/ws/document/doc.loro', 'bad bytes', {
      locationKind: 'identity',
    })
    expect(error.message).toBe(
      'Stored canvas data identified by "/tmp/blobs/ws/document/doc.loro" is corrupt: bad bytes',
    )
    expect(error.message).not.toContain('Stored data at')
  })
})
