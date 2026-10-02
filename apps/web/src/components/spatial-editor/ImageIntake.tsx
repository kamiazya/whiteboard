/**
 * The image affordance's hidden file input and the notice that says why an
 * image was not added.
 *
 * Kept together because they answer one question from two ends: the input
 * offers only what the daemon's file route stores, and the notice is where a
 * refusal of anything else — or of an upload the daemon turned away anyway —
 * is said, so no pick, drop or paste ends with nothing happening.
 */
import { X } from 'lucide-react'
import type { RefObject } from 'react'
import { IMAGE_FILE_ACCEPT } from '../../lib/image-upload-policy.js'

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
      {/* Always mounted: a live region that arrives already carrying its text
          is announced inconsistently, one whose text changes is not. Spelled
          as aria-live rather than role="status" so it is not a second status
          region for a page's own one to be told apart from. */}
      <div aria-live="polite" aria-atomic="true" data-testid="image-notice" data-editor-overlay>
        {notice !== null && (
          <div className="absolute bottom-20 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-lg">
            <span>{notice}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={onDismissNotice}
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </>
  )
}
