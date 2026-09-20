import { describe, expect } from 'vitest'
import { deriveDocumentKey, openBytes, sealBytes } from './read-plane.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const workspaceKeyArb = fc.uint8Array({ minLength: 32, maxLength: 32 })
const saltArb = fc.uint8Array({ minLength: 16, maxLength: 64 })
const documentIdArb = fc.string({ minLength: 1, maxLength: 32 })
const epochArb = fc.nat({ max: 1_000_000 })
const plaintextArb = fc.uint8Array({ minLength: 0, maxLength: 256 })

describe('read-plane: round trip and sibling-key attenuation', () => {
  fcTest.prop(
    [workspaceKeyArb, saltArb, documentIdArb, epochArb, plaintextArb, fc.boolean(), fc.nat()],
    withDefaults(),
  )(
    'open(seal(x)) === x; a sibling differing in documentId or epoch, a raw-imported key, and a wrong aad all fail to open',
    async (
      workspaceKey,
      workspaceKeySalt,
      documentId,
      epoch,
      plaintext,
      siblingVariesDocumentId,
      epochDelta,
    ) => {
      const context = { documentId, epoch }
      const key = await deriveDocumentKey({ workspaceKey, workspaceKeySalt, documentId, epoch })

      // Round trip.
      const envelope = await sealBytes(key, plaintext, context)
      const opened = await openBytes(key, envelope, context)
      expect(opened).toEqual(plaintext)

      // Sibling key: exactly one of documentId or epoch differs.
      const siblingDocumentId = siblingVariesDocumentId ? `${documentId}~sibling` : documentId
      const siblingEpoch = siblingVariesDocumentId ? epoch : epoch + 1 + (epochDelta % 1000)
      const siblingContext = { documentId: siblingDocumentId, epoch: siblingEpoch }
      const siblingKey = await deriveDocumentKey({
        workspaceKey,
        workspaceKeySalt,
        documentId: siblingDocumentId,
        epoch: siblingEpoch,
      })
      await expect(openBytes(siblingKey, envelope, context)).rejects.toMatchObject({
        name: 'OperationError',
      })

      // A key imported directly from the raw workspaceKey (mutation check:
      // the derivation step itself is what separates keys, not something
      // incidental to how the key object is constructed).
      const rawKey = await crypto.subtle.importKey(
        'raw',
        workspaceKey.slice(0, 32),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
      )
      await expect(openBytes(rawKey, envelope, context)).rejects.toMatchObject({
        name: 'OperationError',
      })

      // Same key, wrong aad (the sibling's context, not the sealing one).
      await expect(openBytes(key, envelope, siblingContext)).rejects.toMatchObject({
        name: 'OperationError',
      })
    },
  )
})
