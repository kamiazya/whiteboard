/**
 * The image affordance's hidden file input and the notice that says why an
 * image was not added.
 *
 * Kept together because they answer one question from two ends: the input
 * offers only what the daemon's file route stores, and the notice is where a
 * refusal of anything else — or of an upload the daemon turned away anyway —
 * is said, so no pick, drop or paste ends with nothing happening.
 */
import type { RefObject } from 'react'
import { IMAGE_FILE_ACCEPT } from '../../lib/image-upload-policy.js'
import { CanvasNotice } from './CanvasNotice.js'

export interface ImageIntakeProps {
  readonly inputRef: RefObject<HTMLInputElement | null>
  readonly onFile: (file: File) => void
  readonly notice: string | null
  readonly onDismissNotice: () => void
}

export function ImageIntake({ inputRef, onFile, notice, onDismissNotice }: ImageIntakeProps) {
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
          if (file !== undefined) onFile(file)
        }}
      />
      <CanvasNotice testId="image-notice" notice={notice} onDismiss={onDismissNotice} />
    </>
  )
}
