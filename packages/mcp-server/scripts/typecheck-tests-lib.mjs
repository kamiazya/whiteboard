// The comparison behind `typecheck-tests.mjs`, kept apart from the process
// spawning so it can be tested on text.

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): /

/**
 * Splits `tsc --pretty false` output into errors per file. An error that names
 * no file (a bad option, a missing config) cannot be ledgered and is returned
 * apart, because tolerating it would tolerate a program that never ran.
 */
export function parseDiagnostics(output) {
  const byFile = new Map()
  const unattributed = []
  for (const line of output.split('\n')) {
    const m = DIAGNOSTIC.exec(line)
    if (m) {
      const file = m[1].replaceAll('\\', '/')
      byFile.set(file, (byFile.get(file) ?? 0) + 1)
    } else if (/\berror TS\d+:/.test(line)) {
      unattributed.push(line)
    }
  }
  return { byFile, unattributed }
}

/**
 * Judges the actual per-file error counts against the ledger of files known to
 * carry errors. Both sides fail: an error in an unledgered file is new debt,
 * and a ledgered file with fewer errors than recorded has been paid down
 * without the record following — which is what lets the ledger only shrink.
 */
export function compareToLedger(byFile, ledger) {
  const added = []
  const grew = []
  const shrunk = []
  const cleared = []
  for (const [file, count] of byFile) {
    const recorded = ledger[file]
    if (recorded === undefined) added.push({ file, count })
    else if (count > recorded) grew.push({ file, count, recorded })
    else if (count < recorded) shrunk.push({ file, count, recorded })
  }
  for (const [file, recorded] of Object.entries(ledger)) {
    if (!byFile.has(file)) cleared.push({ file, recorded })
  }
  const failed = added.length + grew.length + shrunk.length + cleared.length > 0
  return { added, grew, shrunk, cleared, failed }
}

/** The ledger after paying debt down; refuses to record anything that grew. */
export function ratchetLedger(byFile, ledger) {
  const verdict = compareToLedger(byFile, ledger)
  if (verdict.added.length > 0 || verdict.grew.length > 0) return { ok: false, verdict }
  const next = {}
  for (const [file, count] of byFile) next[file] = count
  return { ok: true, ledger: next, verdict }
}
