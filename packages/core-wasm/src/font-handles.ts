import { REGISTER_LAYOUT_FONTS_CAPS, type RefusalCode } from './generated/input-caps.js'
import { wireOf } from './value-wire.js'

// The faces a font-table measurer reads cross into the core once, at
// `register_layout_fonts`, and a layout names them by the handle that
// answered (owner decision q76): the daemon's four faces are 1.45 MB, which
// every layout used to copy in.

/** One face a font-table measurer reads, by family and slot. */
interface LayoutFace {
  readonly family: string
  readonly bold: boolean
  readonly italic: boolean
  readonly bytes: Uint8Array
}

/** A font-table measurer as a request names it. Its identity is what is registered. */
export interface LayoutFaces {
  readonly kind: 'fonts'
  readonly faces: readonly LayoutFace[]
}

/** The glue calls this module makes. */
export interface FontsGlue {
  register_layout_fonts(bytes: Uint8Array, faces: string): string
  release_layout_fonts(handle: number): boolean
}

/** The errors this module throws. */
interface FontsErrors {
  refused(operation: string, code: RefusalCode, detail?: string): Error
}

/** What releases a handle once the measurer naming it is collected; a `FinalizationRegistry`. */
export interface Finalizer {
  register(target: object, handle: number, token: object): void
  unregister(token: object): void
}

const OPERATION = 'register_layout_fonts'

/** A handle, or the class of a registration the core will not hold. */
type Registered = { readonly handle: number } | { readonly declined: string }

/**
 * The declines that depend on what the instance holds rather than on the
 * faces, so a later registration of the same faces may succeed.
 */
const OUTGROWN = new Set(['held', 'handles'])

/**
 * The handles one core holds, by the measurer each names: a measurer is
 * registered on its first layout and released when it is collected.
 */
export class FontHandles {
  readonly #held = new WeakMap<LayoutFaces, number>()
  // Asking again would copy every face in again to hear the same answer, on
  // every layout a daemon with such a face installed makes.
  readonly #declined = new WeakMap<LayoutFaces, string>()
  readonly #glue: FontsGlue
  readonly #errors: FontsErrors
  readonly #collected: Finalizer

  constructor(
    glue: FontsGlue,
    errors: FontsErrors,
    finalizer: (release: (handle: number) => void) => Finalizer = (release) =>
      new FinalizationRegistry(release),
  ) {
    this.#glue = glue
    this.#errors = errors
    this.#collected = finalizer((handle) => glue.release_layout_fonts(handle))
  }

  /** The handle naming `faces`, registering them unless they are held. */
  handleOf(faces: LayoutFaces): Registered {
    const held = this.#held.get(faces)
    if (held !== undefined) return { handle: held }
    const declined = this.#declined.get(faces)
    if (declined !== undefined) return { declined }
    const registered = this.#register(faces)
    if ('handle' in registered) {
      this.#held.set(faces, registered.handle)
      this.#collected.register(faces, registered.handle, faces)
    } else if (!OUTGROWN.has(registered.declined)) {
      this.#declined.set(faces, registered.declined)
    }
    return registered
  }

  /** Forgets the handle naming `faces`, which the core answered it holds nothing under. */
  forget(faces: LayoutFaces): void {
    this.#held.delete(faces)
    this.#collected.unregister(faces)
  }

  #register({ faces }: LayoutFaces): Registered {
    // Faces may share one array, so their summed length is checked before the
    // copy is sized: it could otherwise be more than can be allocated.
    const length = faces.reduce((n, face) => n + face.bytes.byteLength, 0)
    if (length > REGISTER_LAYOUT_FONTS_CAPS.maxBytes) return { declined: 'too-large' }
    const bytes = new Uint8Array(length)
    let at = 0
    const placed = faces.map(({ bytes: face, ...rest }) => {
      bytes.set(face, at)
      at += face.byteLength
      return { ...rest, from: at - face.byteLength, to: at }
    })
    const wire = wireOf(placed, 0, true)
    if (wire === undefined) throw this.#errors.refused(OPERATION, 'malformed', 'wire')
    const text = JSON.stringify(wire)
    if (bytes.byteLength + text.length > REGISTER_LAYOUT_FONTS_CAPS.maxBytes) {
      return { declined: 'too-large' }
    }
    const [kind, a, b] = JSON.parse(this.#glue.register_layout_fonts(bytes, text)) as unknown[]
    if (kind === 'ok' && typeof a === 'number') return { handle: a }
    if (kind === 'refused' && a === 'input-too-large' && typeof b === 'string') {
      return { declined: b }
    }
    const detail = kind === 'refused' && typeof b === 'string' ? b : 'answer'
    throw this.#errors.refused(OPERATION, 'malformed', detail)
  }
}
