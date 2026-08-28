import { describe, expect, it } from 'vitest'
import { corruptStoredData } from './corrupt-stored-data.js'

describe('corruptStoredData', () => {
  it('phrases the argument as a real file location', () => {
    const error = corruptStoredData('/tmp/blobs/ws/document/doc.loro', 'bad bytes')
    expect(error.message).toBe(
      'Stored data at "/tmp/blobs/ws/document/doc.loro" is corrupt: bad bytes',
    )
  })
})
