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
import {
  type ReactNode,
  type RefObject,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ImageStoreResult } from '../../lib/document-file-contract.js'
import { IMAGE_FILE_ACCEPT, imageRefusal } from '../../lib/image-upload-policy.js'
import { createSubscribers } from '../../lib/subscribers.js'
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
 * The notice for an upload that finished after its editor was gone — a
 * document switch or a CRDT rebind remounts the editor mid-upload, and the
 * held position goes with the old view. It lives outside every editor so
 * the one mounted next can say what happened, instead of "Uploading…"
 * simply vanishing over a picture that is stored and named nowhere.
 */
let stranded: string | null = null
const strandedChanged = createSubscribers()
function setStranded(next: string | null): void {
  if (stranded === next) return
  stranded = next
  strandedChanged.emit()
}

function strandedMessage(fileName: string | null | undefined): string {
  return fileName === null || fileName === undefined
    ? 'The images were uploaded but not added: the note was reopened meanwhile. Add them again with Image….'
    : `${fileName} was uploaded but not added: the note was reopened meanwhile. Add it again with Image….`
}

function uploadingNotice(files: readonly File[]): string {
  return files.length === 1 ? `Uploading ${files[0]?.name}…` : `Uploading ${files.length} images…`
}

/**
 * Writes what a batch stored at its held position, says what did not
 * store, and — when the editor that held the position is gone — says the
 * pictures were stored but not added.
 */
function writeStored(
  api: SourcePaneApi | null,
  token: string,
  files: readonly File[],
  results: readonly ImageStoreResult[],
  refusal: string | null,
  setNotice: SetNotice,
): void {
  const markup = results.flatMap((result, i) =>
    result.ok ? [imageMarkup(files[i]?.name ?? '', result.ref)] : [],
  )
  const failed = results.find((result) => !result.ok)
  setNotice(failed === undefined || failed.ok ? refusal : failed.reason)
  if (markup.length === 0) return api?.applyEffects(dropPendingImage(token))
  let inserted = false
  api?.run((target) => {
    inserted = insertPendingImage(token, markup.join('\n\n'))(target)
    return inserted
  })
  if (!inserted) setStranded(strandedMessage(markup.length === 1 ? files[0]?.name : null))
}

/**
 * The intake itself, built once per editor: the paste and drop handlers are
 * installed at view creation, so they read the seam through `storeRef`.
 */
function intakeFor(
  storeRef: RefObject<StoreImage | undefined>,
  sourceApiRef: RefObject<SourcePaneApi | null>,
  setNotice: SetNotice,
) {
  /**
   * Holds the position through `hold`, then writes the pictures there once
   * every one is stored. A batch (several files pasted or dropped together)
   * is held as ONE position and written in its own order, a paragraph per
   * picture: held separately, each would land in front of the ones that
   * finished before it, so the note's order would be the uploads' finishing
   * order reversed.
   */
  const store = (files: readonly File[], hold: (token: string) => void) => {
    const save = storeRef.current
    if (save === undefined) return
    const refusal = files.map(imageRefusal).find((reason) => reason !== null) ?? null
    const accepted = files.filter((file) => imageRefusal(file) === null)
    if (accepted.length === 0) return setNotice(refusal)
    const token = `image-${++nextToken}`
    hold(token)
    setNotice(uploadingNotice(accepted))
    void Promise.all(accepted.map((file) => save(file))).then((results) =>
      writeStored(sourceApiRef.current, token, accepted, results, refusal, setNotice),
    )
  }
  /** Takes the event over only when it carries an image this editor can store. */
  const intake = (event: Event, view: EditorView, files: File[], at?: number) => {
    if (files.length === 0 || storeRef.current === undefined) return false
    event.preventDefault()
    store(files, (token) => startPendingImage(token, at)(view))
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
    store([file], (token) => sourceApiRef.current?.run(startPendingImage(token)))
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
  const [ownNotice, setOwnNotice] = useState<string | null>(null)
  const strandedNotice = useSyncExternalStore(
    strandedChanged.subscribe,
    () => stranded,
    () => null,
  )
  const notice = ownNotice ?? strandedNotice
  const inputRef = useRef<HTMLInputElement | null>(null)
  const storeRef = useRef(storeImage)
  storeRef.current = storeImage
  const attach = useMemo(() => {
    // Anything this editor says next is newer than an earlier editor's word.
    const setNotice: SetNotice = (next) => {
      setOwnNotice(next)
      setStranded(null)
    }
    return intakeFor(storeRef, sourceApiRef, setNotice)
  }, [sourceApiRef])
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
        onDismiss={() => {
          setOwnNotice(null)
          setStranded(null)
        }}
      />
    ),
  }
}
