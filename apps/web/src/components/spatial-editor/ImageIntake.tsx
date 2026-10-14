/**
 * The image affordance's hidden file input and the notice that says why an
 * image was not added.
 *
 * Kept together because they answer one question from two ends: the input
 * offers only what the daemon's file route stores, and the notice is where a
 * refusal of anything else — or of an upload the daemon turned away anyway —
 * is said, so no pick, drop or paste ends with nothing happening.
 */
import { type MutableRefObject, useMemo, useRef } from 'react'
import { IMAGE_FILE_ACCEPT } from '../../lib/image-upload-policy.js'
import type { Point } from '../../lib/spatial/viewport.js'
import { CanvasNotice } from './CanvasNotice.js'

/** What the opener of the picker asks the next pick to be. */
export interface ImageRequest {
  /** The frame whose background the pick becomes; null for an image node. */
  readonly backgroundGroupId: string | null
  /** Where an image node lands; null for the viewport centre. */
  readonly point: Point | null
}

/** The hidden input and the one request its next pick answers. */
export interface ImagePicker {
  readonly input: MutableRefObject<HTMLInputElement | null>
  readonly request: MutableRefObject<ImageRequest>
}

export function useImagePicker(): ImagePicker {
  const input = useRef<HTMLInputElement | null>(null)
  const request = useRef<ImageRequest>({ backgroundGroupId: null, point: null })
  return useMemo(() => ({ input, request }), [])
}

/**
 * The only way to open the picker. An opener states the WHOLE request, so a
 * pick answers exactly the last opener and nothing an earlier, dismissed one
 * asked for. That is why no request is spent or withdrawn: a dismissal is not
 * reported by every browser, so a design that needs to hear of it fails where
 * it is not.
 */
export function openImagePicker(picker: ImagePicker, request: ImageRequest): void {
  picker.request.current = request
  picker.input.current?.click()
}

export interface ImageIntakeProps {
  readonly picker: ImagePicker
  readonly onFile: (file: File, request: ImageRequest) => void
  readonly notice: string | null
  readonly onDismissNotice: () => void
}

export function ImageIntake({ picker, onFile, notice, onDismissNotice }: ImageIntakeProps) {
  return (
    <>
      <input
        ref={picker.input}
        data-editor-overlay
        data-testid="image-file-input"
        type="file"
        accept={IMAGE_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file !== undefined) onFile(file, picker.request.current)
        }}
      />
      <CanvasNotice testId="image-notice" notice={notice} onDismiss={onDismissNotice} />
    </>
  )
}
