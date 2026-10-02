import { useState } from 'react'
import type { ImageStoreResult } from '../../lib/document-file-contract.js'
import { imageRefusal } from '../../lib/image-upload-policy.js'
import type { Point } from '../../lib/spatial/viewport.js'

export interface ImageIntakeInputs {
  readonly onAddImage: ((file: File) => Promise<ImageStoreResult>) | undefined
  readonly createImageNodeAt: (ref: string, at?: Point) => void
}

/**
 * Image intake: checks a picked, dropped or pasted file against what the
 * daemon stores, hands it to the host seam, and runs the caller's step with
 * the new reference. Every way it can come to nothing — an unsupported file,
 * an upload the host reports refused — lands in `imageNotice`, so no intake
 * ends silently.
 */
export function useImageIntake({ onAddImage, createImageNodeAt }: ImageIntakeInputs) {
  const [imageNotice, setImageNotice] = useState<string | null>(null)

  const storeImageFile = (file: File, onStored: (ref: string) => void) => {
    if (onAddImage === undefined) return
    const refusal = imageRefusal(file)
    if (refusal !== null) {
      setImageNotice(refusal)
      return
    }
    setImageNotice(null)
    void onAddImage(file).then((result) => {
      if (result.ok) onStored(result.ref)
      else setImageNotice(result.reason)
    })
  }

  return {
    imageNotice,
    dismissImageNotice: () => setImageNotice(null),
    storeImageFile,
    /** Stores the image, then creates its node (at `at`, else the free spot). */
    addImageFile: (file: File, at?: Point) =>
      storeImageFile(file, (ref) => createImageNodeAt(ref, at)),
  }
}
