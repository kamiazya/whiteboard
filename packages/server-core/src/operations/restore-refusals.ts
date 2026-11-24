import { InvalidRestoreTargetPath, RestoredDocumentIdMissing } from '@kamiazya/whiteboard-model'

// The restore's refusals raised beside its result union: each says its
// sentence through the generated message function, so a restore answered from
// the same contract entry in Rust says it byte for byte.

/** A `targetPath` that is not a document path. */
export class InvalidRestoreTargetPathError extends Error {
  constructor(public readonly targetPath: string | undefined) {
    super(InvalidRestoreTargetPath(String(targetPath)))
    this.name = 'InvalidRestoreTargetPathError'
  }
}

/**
 * The restore landed but the target's row lists no document id, so the
 * caller cannot be told which document now holds it. Named, so a server-mode
 * caller reads this rather than a bare internal error.
 */
export class RestoredDocumentIdMissingError extends Error {
  constructor(public readonly targetPath: string) {
    super(RestoredDocumentIdMissing(targetPath))
    this.name = 'RestoredDocumentIdMissingError'
  }
}
