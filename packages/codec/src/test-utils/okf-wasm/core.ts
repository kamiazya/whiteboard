import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import { type OkfCodec, okfCodec } from '../../okf/okf-core.js'

/**
 * The OKF envelope as a root runs it under `rust`, over the staged artifact:
 * the core answers, and a call it declines is answered by the TypeScript, as
 * `okfCodec` does in production, each decline recorded (`declined`). Layer 1 of QR-21 (`vitest.rust.config.ts`)
 * points codec's own OKF suites here instead of at `parse.ts` and
 * `serialize.ts`, and counts what the core answered so a suite the core never
 * reached cannot read as a pass.
 */
const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
const core = await loadCore(readFileSync(artifact))

export const answered = { parseOkf: 0, serializeOkf: 0 }

/** Calls the core declined since the last `declined.length = 0`; the TypeScript answered each. */
export const declined: { fn: string; reason: string }[] = []

const counted: OkfCodec = okfCodec({
  okf: {
    parseOkf: (text) => {
      const answer = core.parseOkf(text)
      answered.parseOkf++
      return answer
    },
    serializeOkf: (doc) => {
      const answer = core.serializeOkf(doc)
      answered.serializeOkf++
      return answer
    },
  },
  impl: { parseOkf: 'rust', serializeOkf: 'rust' },
  onMismatch: (mismatch) => {
    if (mismatch.kind !== 'declined') return
    const { err } = mismatch
    declined.push({ fn: mismatch.fn, reason: err instanceof Error ? err.message : String(err) })
  },
})

export const rustOkf = counted
