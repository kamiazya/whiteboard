/**
 * A note's image intake: the Image verb's picker, and a pasted or dropped
 * image file. Each stores the file through the keeper's own seam — the same
 * `storeImage` a canvas's Add > Image uses, so both keepers and their file
 * collections already know the result — and writes `![name](asset:…)` where
 * the caret was when the upload began.
 *
 * Every way an intake comes to nothing lands in the notice, as on a canvas:
 * a file the daemon would not store is refused before any upload, and a
 * refusal from the keeper says its own reason. Without a seam there is no
 * Image verb, and a paste or drop is left to CodeMirror, which ignores a file.
 */
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { X } from 'lucide-react'
import { type ReactNode, type RefObject, useMemo, useRef, useState } from 'react'
import type { ImageStoreResult } from '../../lib/document-file-contract.js'
import { IMAGE_FILE_ACCEPT, imageRefusal } from '../../lib/image-upload-policy.js'
import {
  dropPendingImage,
  imageMarkup,
  insertPendingImage,
  pendingImages,
  startPendingImage,
} from './image-markup.js'
import type { SourcePaneApi } from './SourcePane.js'

export type StoreImage = (file: File) => Promise<ImageStoreResult>

export interface ImageAttach {
  /** Opens the picker; absent when the host stores no files. */
  readonly pickImage: (() => void) | undefined
  /** Paste and drop handling plus the held insertion points; empty without a seam. */
  readonly extension: readonly Extension[]
  /** The hidden input and the notice, rendered once inside the editor's root. */
  readonly element: ReactNode
}

/** Only image files: a paste of text that also carries a file is the platform's to handle. */
function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((file) => file.type.startsWith('image/'))
}

let nextToken = 0

type SetNotice = (notice: string | null) => void

/**
 * The intake itself, built once per editor: the paste and drop handlers are
 * installed at view creation, so they read the seam through `storeRef`.
 */
function intakeFor(
  storeRef: RefObject<StoreImage | undefined>,
  sourceApiRef: RefObject<SourcePaneApi | null>,
  setNotice: SetNotice,
) {
  /** Holds the position through `hold`, then writes the picture there once stored. */
  const store = (file: File, hold: (token: string) => void) => {
    const save = storeRef.current
    if (save === undefined) return
    const refusal = imageRefusal(file)
    if (refusal !== null) return setNotice(refusal)
    const token = `image-${++nextToken}`
    hold(token)
    setNotice(`Uploading ${file.name}…`)
    void save(file).then((result) => {
      setNotice(result.ok ? null : result.reason)
      if (result.ok) {
        sourceApiRef.current?.run(insertPendingImage(token, imageMarkup(file.name, result.ref)))
      } else sourceApiRef.current?.applyEffects(dropPendingImage(token))
    })
  }
  /** Takes the event over only when it carries an image this editor can store. */
  const intake = (event: Event, view: EditorView, files: File[], at?: number) => {
    if (files.length === 0 || storeRef.current === undefined) return false
    event.preventDefault()
    for (const file of files) store(file, (token) => startPendingImage(token, at)(view))
    return true
  }
  const extension: Extension[] = [
    pendingImages,
    EditorView.domEventHandlers({
      paste: (event, view) => intake(event, view, imageFiles(event.clipboardData?.files)),
      drop: (event, view) => {
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined
        return intake(event, view, imageFiles(event.dataTransfer?.files), at)
      },
    }),
  ]
  const picked = (file: File) =>
    store(file, (token) => sourceApiRef.current?.run(startPendingImage(token)))
  return { extension, picked }
}

/**
 * The hidden input and the notice. Always mounted while there is a seam: a
 * live region that arrives already carrying its text is announced
 * inconsistently, one whose text changes is not.
 */
function ImageAttachControls({
  inputRef,
  onFile,
  notice,
  onDismiss,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  onFile: (file: File) => void
  notice: string | null
  onDismiss: () => void
}) {
  return (
    <>
      <input
        ref={inputRef}
        data-testid="note-image-input"
        type="file"
        accept={IMAGE_FILE_ACCEPT}
        aria-label="Choose an image"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) onFile(file)
        }}
      />
      <div aria-live="polite" aria-atomic="true" data-testid="note-image-notice">
        {notice !== null && (
          <div className="absolute bottom-20 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-lg">
            <span>{notice}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-accent focus-visible:bg-accent focus-visible:outline-none pointer-coarse:size-11"
              onClick={onDismiss}
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </>
  )
}

export function useImageAttach(
  storeImage: StoreImage | undefined,
  sourceApiRef: RefObject<SourcePaneApi | null>,
): ImageAttach {
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const storeRef = useRef(storeImage)
  storeRef.current = storeImage
  const attach = useMemo(() => intakeFor(storeRef, sourceApiRef, setNotice), [sourceApiRef])
  if (storeImage === undefined)
    return { pickImage: undefined, extension: attach.extension, element: null }
  return {
    pickImage: () => inputRef.current?.click(),
    extension: attach.extension,
    element: (
      <ImageAttachControls
        inputRef={inputRef}
        onFile={attach.picked}
        notice={notice}
        onDismiss={() => setNotice(null)}
      />
    ),
  }
}
