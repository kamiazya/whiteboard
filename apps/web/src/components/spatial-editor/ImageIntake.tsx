/**
 * The image affordance's hidden file input and the notice that says why an
 * image was not added.
 *
 * Kept together because they answer one question from two ends: the input
 * offers only what the daemon's file route stores, and the notice is where a
 * refusal of anything else — or of an upload the daemon turned away anyway —
 * is said, so no pick, drop or paste ends with nothing happening.
 */
import { type MutableRefObject, type RefObject, useEffect } from 'react'
import { IMAGE_FILE_ACCEPT } from '../../lib/image-upload-policy.js'
import type { Point } from '../../lib/spatial/viewport.js'
import { CanvasNotice } from './CanvasNotice.js'

/** What the opener of the picker asked the next pick to be. */
interface ImageRequest {
  /** The frame whose background the pick becomes; null for an image node. */
  readonly backgroundGroupId: string | null
  /** Where an image node lands; null for the viewport centre. */
  readonly point: Point | null
}

export interface ImageIntakeProps {
  readonly inputRef: RefObject<HTMLInputElement | null>
  /** Set by whichever opener ran last. */
  readonly backgroundRequestRef: MutableRefObject<string | null>
  readonly pointRequestRef: MutableRefObject<Point | null>
  readonly onFile: (file: File, request: ImageRequest) => void
  readonly notice: string | null
  readonly onDismissNotice: () => void
}

export function ImageIntake({
  inputRef,
  backgroundRequestRef,
  pointRequestRef,
  onFile,
  notice,
  onDismissNotice,
}: ImageIntakeProps) {
  // A pick spends the request and a dismissed picker withdraws it, both in
  // one place: an opener that does not restate a request would otherwise
  // inherit it. React binds `onCancel` for <dialog> only, hence the listener.
  const takeRequest = (): ImageRequest => {
    const request = {
      backgroundGroupId: backgroundRequestRef.current,
      point: pointRequestRef.current,
    }
    backgroundRequestRef.current = null
    pointRequestRef.current = null
    return request
  }
  useEffect(() => {
    const input = inputRef.current
    if (input === null) return
    const withdraw = () => {
      backgroundRequestRef.current = null
      pointRequestRef.current = null
    }
    input.addEventListener('cancel', withdraw)
    return () => input.removeEventListener('cancel', withdraw)
  }, [inputRef, backgroundRequestRef, pointRequestRef])
  return (
    <>
      <input
        ref={inputRef}
        data-editor-overlay
        data-testid="image-file-input"
        type="file"
        accept={IMAGE_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file !== undefined) onFile(file, takeRequest())
        }}
      />
      <CanvasNotice testId="image-notice" notice={notice} onDismiss={onDismissNotice} />
    </>
  )
}
