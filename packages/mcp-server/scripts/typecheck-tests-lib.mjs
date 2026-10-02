// The comparison behind `typecheck-tests.mjs`, kept apart from the process
// spawning so it can be tested on text.
//
// A file's debt is the sorted list of error CODES it carries, not a count. A
// count lets one error be swapped for a different one — fix the old, introduce
// a new — and report the same number; the codes make the swap a failure. The
// ledger stays free of messages and line numbers on purpose: those move with
// every unrelated edit, and a ledger that churned on them would be re-recorded
// by habit until it recorded nothing.

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): /

/**
 * Splits `tsc --pretty false` output into the sorted error codes per file. An
 * error that names no file (a bad option, a missing config) cannot be ledgered
 * and is returned apart, because tolerating it would tolerate a program that
 * never ran.
 */
export function parseDiagnostics(output) {
  const byFile = new Map()
  const unattributed = []
  for (const line of output.split('\n')) {
    const m = DIAGNOSTIC.exec(line)
    if (m) {
      const file = m[1].replaceAll('\\', '/')
      byFile.set(file, [...(byFile.get(file) ?? []), m[4]].sort())
    } else if (/\berror TS\d+:/.test(line)) {
      unattributed.push(line)
    }
  }
  return { byFile, unattributed }
}

function tally(codes) {
  const counts = new Map()
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1)
  return counts
}

/** Codes `actual` carries more often than `recorded` does, with both counts. */
function surplus(actual, recorded) {
  const have = tally(recorded)
  return [...tally(actual)]
    .filter(([code, count]) => count > (have.get(code) ?? 0))
    .map(([code, count]) => ({ code, count, recorded: have.get(code) ?? 0 }))
}

/**
 * Judges the actual per-file error codes against the ledger of files known to
 * carry errors. Every disagreement fails, and each says what kind it is:
 *  - `added`: errors in a file the ledger does not name — new debt;
 *  - `grew`: more errors than recorded;
 *  - `swapped`: no more errors than recorded, but a code that was not owed —
 *    something was repaired and something else broke, which a count hides;
 *  - `shrunk`: fewer errors than recorded, all of them owed — paid down without
 *    the record following, which is what lets the ledger only shrink;
 *  - `cleared`: a ledgered file with no errors left.
 */
export function compareToLedger(byFile, ledger) {
  const added = []
  const grew = []
  const swapped = []
  const shrunk = []
  const cleared = []
  for (const [file, codes] of byFile) {
    const recorded = ledger[file]
    if (recorded === undefined) {
      added.push({ file, count: codes.length, codes })
      continue
    }
    const novel = surplus(codes, recorded)
    const entry = { file, count: codes.length, recorded: recorded.length, novel }
    if (codes.length > recorded.length) grew.push(entry)
    else if (novel.length > 0) swapped.push(entry)
    else if (codes.length < recorded.length) shrunk.push(entry)
  }
  for (const [file, recorded] of Object.entries(ledger)) {
    if (!byFile.has(file)) cleared.push({ file, recorded: recorded.length })
  }
  const failed = added.length + grew.length + swapped.length + shrunk.length + cleared.length > 0
  return { added, grew, swapped, shrunk, cleared, failed }
}

/**
 * The ledger after paying debt down; refuses to record anything that grew or
 * changed — a swap is not paid-down debt, it is new debt beside a repair.
 */
export function ratchetLedger(byFile, ledger) {
  const verdict = compareToLedger(byFile, ledger)
  if (verdict.added.length > 0 || verdict.grew.length > 0 || verdict.swapped.length > 0) {
    return { ok: false, verdict }
  }
  const next = {}
  for (const [file, codes] of byFile) next[file] = codes
  return { ok: true, ledger: next, verdict }
}
