/**
 * Where a conversation's passage IS, kept by the CRDT itself.
 *
 * A thread stores the quote it is about (ADR-0026), which is what survives a
 * document leaving the CRDT — an OKF markdown export, a rebuild elsewhere.
 * What a quote cannot do is follow a concurrent edit exactly, and the stored
 * offsets beside it are an approximation that goes wrong the moment someone
 * else types above the passage.
 *
 * A Loro rich-text MARK is the exact answer, because the range belongs to the
 * characters rather than to a number. Measured on loro-crdt 1.13.6: it
 * follows a merged peer's inserts, grows when text is typed inside it,
 * shrinks when part of it is deleted, survives a snapshot and a shallow
 * snapshot — and DISAPPEARS when its passage is deleted, which is the
 * orphan signal offsets could never give.
 *
 * So the mark is the live anchor and the quote is the durable identity.
 * Neither replaces the other.
 */
import type { LoroDoc } from 'loro-crdt'
import { readAnnotations } from './annotations.js'
import type { DocumentContainers } from './containers.js'
import { MARKDOWN_BODY_KEY } from './loro-bridge.js'

const KEY_PREFIX = 'comment-'

/**
 * Characters a Loro style key may carry verbatim.
 *
 * `:` is not among them for a reason worth stating plainly: a style key
 * containing one does not throw, it ABORTS THE WASM with
 * `RuntimeError: unreachable`, taking the whole process with it. Measured;
 * `-`, `_`, `.`, `/`, a space and every alphanumeric were fine, and this set
 * is deliberately narrower than what was proven safe.
 *
 * It matters because `annotationIdSchema` is `z.string().min(1)` — any
 * non-empty string — so a thread id an MCP peer supplies can contain
 * anything at all. Interpolating one into a key would hand that peer a
 * remote crash.
 */
const SAFE_KEY_CHARS = /[A-Za-z0-9_.~-]/

/**
 * The style key one thread's passage is marked with.
 *
 * Percent-encoded rather than base64: every id this app mints (a UUID, a
 * ULID) is already safe, so the key stays readable in a snapshot dump, and
 * only an exotic id pays for the escaping. Injective, because `%` is escaped
 * too — which is what lets `readThreadMarks` map a key back to its thread.
 */
export function threadStyleKey(threadId: string): string {
  let encoded = ''
  for (const char of threadId) {
    encoded += SAFE_KEY_CHARS.test(char) && char !== '%' ? char : encodeURIComponent(char)
  }
  return KEY_PREFIX + encoded
}

function threadIdFromStyleKey(key: string): string | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined
  try {
    return decodeURIComponent(key.slice(KEY_PREFIX.length))
  } catch {
    // A key this package did not write, carrying a stray `%`. Not ours to
    // interpret, and not a reason to fail the whole read.
    return undefined
  }
}

/**
 * Registers the style keys this document is allowed to mark with.
 *
 * Takes the COMPLETE set every time, because `configTextStyle` replaces its
 * configuration rather than adding to it — measured: after a second call
 * naming only a new key, marking with the first one throws
 * `Style configuration missing`. Re-configuring does not disturb marks
 * already written.
 *
 * Module-private, and `markThreadPassages` below is the only caller, because
 * a rule stated as "supply the complete set every time" is one a call site
 * can only get wrong — with a throw as the reminder. A READER needs none of
 * this: a peer that never registered anything still sees every mark in
 * `toDelta()`, which is why `readThreadMarks` asks for nothing.
 *
 * `expand: 'none'` so that typing at either edge of a passage is outside the
 * comment rather than silently annexed by it. Text typed strictly INSIDE is
 * included whatever this says — that is the range growing, not the boundary
 * moving.
 */
function configureThreadStyles(doc: LoroDoc, threadIds: Iterable<string>): void {
  const styles: Record<string, { expand: 'none' }> = {}
  for (const id of threadIds) styles[threadStyleKey(id)] = { expand: 'none' }
  doc.configTextStyle(styles)
}

/** A passage in the body, as UTF-16 code-unit offsets. */
export interface PassageRange {
  readonly start: number
  readonly end: number
}

/**
 * Marks each passage, having registered the styles the write needs first.
 *
 * The registration rule is Loro's, not this codebase's: `configTextStyle`
 * REPLACES its configuration and marking with an unregistered key throws, so
 * every writer has to supply the complete set every time. That is a contract
 * a call site can only get wrong, and the throw is the reminder — so the set
 * is derived here instead, from the threads the document already holds
 * unioned with whatever is being marked now.
 *
 * `doc` and `containers` are two arguments rather than one because they are
 * genuinely different things in workspace mode: styles are configured on the
 * whole LoroDoc, while the body being marked belongs to one document's tree
 * node inside it.
 *
 * Takes a map so the backfill — every thread on a document that arrived
 * through a markdown file, re-derived from its quote — is one registration
 * and one commit rather than one of each per thread.
 */
export function markThreadPassages(
  doc: LoroDoc,
  containers: DocumentContainers,
  passages: ReadonlyMap<string, PassageRange>,
): void {
  if (passages.size === 0) return
  const ids = new Set(passages.keys())
  // The document's own threads too: registering replaces, so naming only
  // what is being written now would unregister every key already in use and
  // the NEXT write for one of them would throw.
  for (const thread of readAnnotations(containers)) ids.add(thread.id)
  configureThreadStyles(doc, ids)
  const text = containers.getText(MARKDOWN_BODY_KEY)
  for (const [threadId, range] of passages) {
    if (range.end <= range.start) continue
    text.mark(range, threadStyleKey(threadId), true)
  }
  containers.commit()
}

/**
 * Every thread whose passage is still findable, and where it now is.
 *
 * One walk of the body's delta — measured at 0.39ms over 20,800 characters
 * carrying 40 marks, which is why this is a plain read rather than something
 * cached and invalidated.
 *
 * A thread ABSENT from this map is the interesting answer: either it was
 * never marked (an older document, or one that arrived through a markdown
 * file, where marks do not travel) or its passage was deleted. The caller
 * tells those apart by falling back to the quote, which is the whole reason
 * the quote is still stored.
 */
export function readThreadMarks(doc: DocumentContainers): Map<string, PassageRange> {
  const found = new Map<string, PassageRange>()
  let at = 0
  for (const run of doc.getText(MARKDOWN_BODY_KEY).toDelta()) {
    const text = typeof run.insert === 'string' ? run.insert : ''
    for (const key of Object.keys(run.attributes ?? {})) {
      const threadId = threadIdFromStyleKey(key)
      if (threadId === undefined) continue
      const previous = found.get(threadId)
      found.set(threadId, { start: previous?.start ?? at, end: at + text.length })
    }
    at += text.length
  }
  return found
}
