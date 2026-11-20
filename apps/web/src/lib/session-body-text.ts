import type { documentEngine } from '@kamiazya/whiteboard-model'
import type { BodyDocPort, BodyTextPort } from './body-text-port.js'
import { createSubscribers } from './subscribers.js'

/**
 * A markdown body as the editor's binding writes it: keystrokes land in a
 * mirror the session reads at once and queue as runs, and the owner hands the
 * queue to the engine as ONE splice when the debounce window closes. One
 * splice is one commit, one pushed update and one undo step, however many
 * keystrokes the window held.
 *
 * Positions are UTF-16 code units and each run is expressed against the text
 * as the runs before it left it, which is what the binding's own drift
 * adjustment produces and what the engine applies them as.
 *
 * The mirror is read lazily and dropped (`invalidate`) when the document
 * changes under the editor, so a remote update costs one body read only if
 * somebody looks.
 */
export class SessionBodyText implements BodyTextPort, BodyDocPort {
  private text: string | null = null
  private runs: documentEngine.TextRun[] = []
  private readonly changed = createSubscribers()

  /** `read` answers the committed body from the engine; `commitRuns` sends a queue as one splice. */
  constructor(
    private readonly read: () => string,
    private readonly commitRuns: (runs: documentEngine.TextRun[]) => void,
  ) {}

  toString(): string {
    this.text ??= this.read()
    return this.text
  }

  insert(index: number, text: string): void {
    if (text.length === 0) return
    const held = this.toString()
    this.runs.push({ index, remove: 0, insert: text })
    this.text = held.slice(0, index) + text + held.slice(index)
  }

  delete(index: number, length: number): void {
    if (length <= 0) return
    const held = this.toString()
    this.runs.push({ index, remove: length, insert: '' })
    this.text = held.slice(0, index) + held.slice(index + length)
  }

  /** Whether keystrokes are queued that the engine does not hold yet. */
  get pending(): boolean {
    return this.runs.length > 0
  }

  /** The queue as it stands, left in place. */
  peekRuns(): documentEngine.TextRun[] {
    return [...this.runs]
  }

  private takeRuns(): documentEngine.TextRun[] {
    const taken = this.runs
    this.runs = []
    return taken
  }

  /** The document moved under the mirror: it is read again from the engine on next use. */
  invalidate(): void {
    this.text = null
  }

  subscribe(listener: () => void): () => void {
    return this.changed.subscribe(listener)
  }

  /** Tells every subscriber the body may have changed; they diff it against what they show. */
  notify(): void {
    this.changed.emit()
  }

  /** Ends the binding's transaction: the queue goes to the engine now. */
  commit(): void {
    if (this.pending) this.commitRuns(this.takeRuns())
  }
}
