/**
 * Which backend failures are a READ failure. The answer decides whether the
 * editor is replaced by the load-degraded screen, and that screen offers
 * "Start fresh", which deletes the record — so a write that did not land must
 * never be classified as one.
 */
import { describe, expect, it } from 'vitest'
import { isDocumentReadFailure } from './document-read-failure.js'
import type { BackendErrorReason } from './document-sync-session.js'

// A Record over the whole union, so a reason added to the backend contract
// fails to compile until someone decides which side of this line it is on.
const IS_READ_FAILURE: Record<BackendErrorReason, boolean> = {
  'unsupported-version': true,
  'corrupt-snapshot': true,
  'corrupt-delta': true,
  'read-unavailable': true,
  'storage-failure': false,
  'document-removed': false,
}

describe('isDocumentReadFailure', () => {
  it.each(
    Object.entries(IS_READ_FAILURE),
  )('classifies %s as a read failure: %s', (reason, expected) => {
    expect(isDocumentReadFailure(reason)).toBe(expected)
  })

  it('answers no for the absence of a failure', () => {
    expect(isDocumentReadFailure(null)).toBe(false)
  })
})
