import type {
  Code,
  Construct,
  Extension,
  State,
  TokenizeContext,
  Tokenizer,
} from 'micromark-util-types'

/**
 * A code span (`` ` ``) or inline math (`$`) opener closes at the next run of
 * exactly its own length, and micromark finds out by scanning ahead to the
 * end of the inline run. An opener with no such closer rescans the whole run
 * for nothing, so k openers of distinct lengths cost k times the run — about
 * n^1.5 for a run made of them, which took 13 s at 256 KB.
 *
 * cmark's answer, here: the first opener of a run scans it once and records,
 * per marker and length, where the last run of that length starts. An opener
 * with no later run of its length is then refused without a scan, and reads
 * as the characters it is, exactly as it would after the failed scan. An
 * opener that has one is left to the real construct, whose scan ends at that
 * closer and is consumed by it, so each character is scanned once more at
 * most.
 *
 * The record is exact because both scans read the same raw characters: a
 * code span or math span sees no escapes, no other construct, nothing but
 * maximal runs of its marker, and so does this one. No `previous` is needed
 * to keep it off the middle of a run: it consumes every run it starts on, or
 * hands it to the real construct, which then closes it.
 */

const DOLLAR_SIGN = 36
const GRAVE_ACCENT = 96

/** Marker → run length → offset where the last run of that length starts. */
type Runs = Map<number, Map<number, number>>

/** Keyed as delimiter-budget.ts keys its accounts: one per inline run. */
const scanned = new WeakMap<TokenizeContext['sliceSerialize'], Runs>()

/** Reads the rest of the run without keeping it: used through `check`. */
const scanRuns: Construct = {
  partial: true,
  tokenize(effects, _ok, nok) {
    const runs: Runs = new Map([
      [DOLLAR_SIGN, new Map()],
      [GRAVE_ACCENT, new Map()],
    ])
    const self = this
    let marker: Code = null
    let size = 0
    let start = 0
    return begin

    function begin(code: Code): State | undefined {
      effects.enter('data')
      return step(code)
    }

    function step(code: Code): State | undefined {
      if (marker !== null && code !== marker) {
        runs.get(marker)?.set(size, start)
        marker = null
      }
      if (code === null) {
        scanned.set(self.sliceSerialize, runs)
        effects.exit('data')
        return nok(code)
      }
      if (marker === null && (code === DOLLAR_SIGN || code === GRAVE_ACCENT)) {
        marker = code
        size = 0
        start = self.now().offset
      }
      if (code === marker) size += 1
      effects.consume(code)
      return step
    }
  },
}

function closingRunsFor(marker: number): Construct {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const self = this
    const opener = self.now().offset
    let size = 0
    return start

    function start(code: Code): State | undefined {
      if (scanned.has(self.sliceSerialize)) return measure(code)
      return effects.check(scanRuns, measure, measure)(code)
    }

    function measure(code: Code): State | undefined {
      effects.enter('data')
      return inside(code)
    }

    function inside(code: Code): State | undefined {
      if (code === marker) {
        effects.consume(code)
        size += 1
        return inside
      }
      const last = scanned.get(self.sliceSerialize)?.get(marker)?.get(size)
      if (last !== undefined && last > opener) return nok(code)
      effects.exit('data')
      return ok(code)
    }
  }

  return { name: 'closingRuns', tokenize }
}

/**
 * Must be registered after remark-math: micromark tries a later extension's
 * constructs first.
 */
export const closingRunsExtension: Extension = {
  text: {
    [DOLLAR_SIGN]: closingRunsFor(DOLLAR_SIGN),
    [GRAVE_ACCENT]: closingRunsFor(GRAVE_ACCENT),
  },
}
