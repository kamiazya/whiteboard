// @vitest-environment node
import { documentKindSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_KIND_CHOICES } from './document-kind-choice.js'

describe('DOCUMENT_KIND_CHOICES', () => {
  // Every kind the model admits must be offerable, or a document kind exists
  // that no human surface can create. Markdown was in exactly that position
  // on a daemon workspace before this table existed.
  it('covers every kind exactly once', () => {
    expect(DOCUMENT_KIND_CHOICES.map((c) => c.kind).sort()).toEqual(
      [...documentKindSchema.options].sort(),
    )
  })

  // The defect this table exists to make impossible: a surface drawing both
  // kinds with one icon, so the row says "pick one of these two identical
  // things". A glyph shared between kinds distinguishes nothing.
  it('gives each kind its own label and its own glyph', () => {
    expect(new Set(DOCUMENT_KIND_CHOICES.map((c) => c.label)).size).toBe(
      DOCUMENT_KIND_CHOICES.length,
    )
    expect(new Set(DOCUMENT_KIND_CHOICES.map((c) => c.Icon)).size).toBe(
      DOCUMENT_KIND_CHOICES.length,
    )
  })
})
