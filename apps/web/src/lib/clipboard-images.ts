/**
 * Stored pictures across a copy and paste.
 *
 * A picture node names its bytes by reference (`asset:<id>`), and where those
 * bytes live depends on the keeper: the browser keeps one store per origin,
 * the daemon one per workspace. A reference pasted anywhere else names bytes
 * the target does not hold, and the picture draws as a broken card.
 *
 * So a copy records where its pictures live (`source.fileScope`) and reads
 * their bytes, within the fragment schema's bound. A paste into the SAME
 * scope keeps every reference as it is; a paste into another stores each
 * carried picture through the target keeper's own image seam — the one the
 * picker and a drop use — and remints the references. A picture whose bytes
 * did not come along is left out rather than pasted dangling, and the paste
 * says how many.
 */
import {
  CLIPBOARD_FILES_MAX_BYTES,
  CLIPBOARD_FILES_MAX_COUNT,
  type ClipboardFragment,
  frameBackground,
  isImageRef,
  nodeFile,
  nodeText,
  type SpatialNode,
  storedImageRefs,
} from '@kamiazya/whiteboard-model'
import {
  carriedClipboardFiles,
  readClipboardFragment,
  writeClipboardFragment,
} from './clipboard-store.js'
import type { ImageStoreResult } from './document-file-contract.js'
import { picturesLeftOutNotice } from './limit-notice.js'

/** What the editor needs of its keeper to carry pictures across a paste. */
export interface ClipboardImageSeams {
  /**
   * Where this keeper's stored pictures live. Two keepers answering the same
   * scope hold the same bytes, so a paste between them needs no transfer.
   */
  readonly fileScope: string
  /** The bytes behind a stored-picture reference, or undefined when there are none. */
  readonly readImage: (ref: string) => Promise<Blob | undefined>
  /** Stores a picture in this keeper, answering its new reference or why not. */
  readonly storeImage: (file: File) => Promise<ImageStoreResult>
}

type CarriedFiles = NonNullable<ClipboardFragment['files']>

/** What a paste writes, plus the record of where its pictures came from. */
export type PastedFragment = Pick<
  ClipboardFragment,
  'nodes' | 'edges' | 'lines' | 'cut' | 'files' | 'source'
>

/** The stored pictures a fragment's nodes draw, in the order they are met. */
function fragmentImageRefs(fragment: Pick<ClipboardFragment, 'nodes'>): readonly string[] {
  return storedImageRefs({ canvas: { nodes: fragment.nodes, edges: [] } })
}

/** Chunked so a picture of megabytes never spreads into one call's arguments. */
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(binary)
}

/** The carried bytes as a file the target's image seam takes, or undefined when unreadable. */
function fromBase64(ref: string, asset: CarriedFiles[string]): File | undefined {
  try {
    const binary = atob(asset.dataBase64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new File([bytes], ref.slice(ref.indexOf(':') + 1), { type: asset.mimeType })
  } catch {
    return undefined
  }
}

/**
 * The bytes of each picture, in fragment order, while they fit the schema's
 * bound. A picture that does not fit, or that the keeper cannot read, is
 * left by reference only; the paste counts it.
 */
async function readCarriedFiles(
  refs: readonly string[],
  readImage: ClipboardImageSeams['readImage'],
): Promise<CarriedFiles> {
  const files: Record<string, CarriedFiles[string]> = {}
  let budget = CLIPBOARD_FILES_MAX_BYTES
  for (const ref of refs.slice(0, CLIPBOARD_FILES_MAX_COUNT)) {
    const blob = await readImage(ref).catch(() => undefined)
    if (blob === undefined || blob.type === '' || blob.size > budget) continue
    files[ref] = { mimeType: blob.type, dataBase64: await toBase64(blob) }
    budget -= blob.size
  }
  return files
}

/**
 * Writes the fragment to the in-app slot, stamped with where its pictures
 * live, and starts reading their bytes. Answers the stamped fragment, which
 * is what the copy event puts on the OS clipboard.
 *
 * The copy event's clipboard data must be set synchronously and the bytes
 * arrive later, so the event carries the references and the copy id; once
 * the bytes are read, the OS clipboard is rewritten with them, while this tab
 * still has focus and the slot still holds this copy.
 */
export function writeCarryingImages(
  fragment: ClipboardFragment,
  seams: ClipboardImageSeams | undefined,
): ClipboardFragment {
  const refs = fragmentImageRefs(fragment)
  if (seams === undefined || refs.length === 0) {
    writeClipboardFragment(fragment)
    return fragment
  }
  const stamped: ClipboardFragment = {
    ...fragment,
    source: { fileScope: seams.fileScope, copyId: crypto.randomUUID() },
  }
  const files = readCarriedFiles(refs, seams.readImage)
  writeClipboardFragment(stamped, files)
  void files.then((carried) => {
    if (Object.keys(carried).length === 0) return
    if (readClipboardFragment() !== stamped || !document.hasFocus()) return
    void navigator.clipboard
      ?.writeText(JSON.stringify({ ...stamped, files: carried }))
      .catch(() => undefined)
  })
  return stamped
}

/**
 * Whether a paste must store pictures in this keeper: the fragment draws
 * some, and they come from a different scope — or from nowhere it recorded,
 * which a fragment from an older build or a foreign writer is.
 */
export function needsImageTransfer(
  fragment: PastedFragment,
  seams: ClipboardImageSeams | undefined,
): seams is ClipboardImageSeams {
  if (seams === undefined) return false
  if (fragment.source?.fileScope === seams.fileScope) return false
  return fragmentImageRefs(fragment).length > 0
}

/** `text` with every whole occurrence of each minted reference replaced. */
function rewriteInline(text: string, minted: ReadonlyMap<string, string>): string {
  let out = text
  for (const [from, to] of minted) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`${escaped}(?![A-Za-z0-9_-])`, 'g'), to)
  }
  return out
}

/**
 * One node with its pictures pointed at the target's copies. A picture node
 * whose bytes did not come along is dropped, and a frame keeps its place
 * without the background; an inline picture in a node's text stays as the
 * person wrote it, since the text is theirs to edit.
 */
function retargetNode(
  node: SpatialNode,
  minted: ReadonlyMap<string, string>,
): SpatialNode | undefined {
  const file = nodeFile(node)
  if (file !== undefined && isImageRef(file) && node.resource !== undefined) {
    const to = minted.get(file)
    return to === undefined ? undefined : { ...node, resource: { ...node.resource, location: to } }
  }
  const text = nodeText(node)
  if (text !== undefined && node.resource !== undefined) {
    return { ...node, resource: { ...node.resource, content: rewriteInline(text, minted) } }
  }
  const background = frameBackground(node)
  if (background !== undefined && isImageRef(background)) {
    const to = minted.get(background)
    if (to !== undefined) return { ...node, background: to }
    const { background: _dropped, ...rest } = node
    return rest
  }
  return node
}

/**
 * Stores each carried picture through the target keeper and answers the
 * fragment pointed at the new references, with the notice to show when some
 * did not come along (or null). The bytes are the fragment's own, else the
 * ones this tab read for the same copy.
 */
export async function transferFragmentImages(
  fragment: PastedFragment,
  seams: ClipboardImageSeams,
): Promise<{ readonly fragment: PastedFragment; readonly notice: string | null }> {
  const copyId = fragment.source?.copyId
  const files =
    fragment.files ?? (copyId === undefined ? undefined : await carriedClipboardFiles(copyId))
  const minted = new Map<string, string>()
  let leftOut = 0
  let refusal: string | undefined
  for (const ref of fragmentImageRefs(fragment)) {
    const asset = files?.[ref]
    const file = asset === undefined ? undefined : fromBase64(ref, asset)
    const stored = file === undefined ? undefined : await seams.storeImage(file)
    if (stored?.ok === true) minted.set(ref, stored.ref)
    else {
      leftOut += 1
      if (stored !== undefined) refusal = stored.reason
    }
  }
  const nodes = fragment.nodes.flatMap((node) => retargetNode(node, minted) ?? [])
  return {
    fragment: { ...fragment, nodes },
    notice: leftOut === 0 ? null : picturesLeftOutNotice(leftOut, refusal),
  }
}
