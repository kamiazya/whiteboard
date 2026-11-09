// The ledger of mutants cargo-mutants does not judge (.cargo/mutants.toml,
// QR-17), read and checked. Its own module so a test can import it without
// running the gate: `rust-mutants.mjs` checks each entry against every mutant
// `cargo mutants --list` names, and arch-lint's rust-mutants-ledger.test.ts
// checks the file's shape on every change.

/** How many `exclude_re` entries .cargo/mutants.toml holds: a change is a decision made in the diff. */
const EXCLUSIONS = 31

/**
 * The ledger's entries, each with the comment lines directly above it. A
 * small reader for the one array this file holds, written as single-quoted
 * TOML literals so a regex needs no escaping.
 * @param {string} toml
 * @returns {{ regex: string, literal: boolean, reason: string }[]}
 */
export function ledgerEntries(toml) {
  const lines = toml.split('\n')
  const start = lines.findIndex((l) => /^exclude_re\s*=\s*\[/.test(l))
  if (start === -1) return []
  /** @type {{ regex: string, literal: boolean, reason: string }[]} */
  const entries = []
  /** @type {string[]} */
  let reason = []
  for (const line of lines.slice(start + 1)) {
    const t = line.trim()
    if (t.startsWith(']')) break
    if (t.startsWith('#')) reason.push(t.replace(/^#\s?/, ''))
    else if (t !== '') {
      const m = /^'([^']*)',?$/.exec(t)
      entries.push({ regex: m ? m[1] : t, literal: m !== null, reason: reason.join(' ').trim() })
      reason = []
    }
  }
  return entries
}

/**
 * What is wrong with the ledger against `names`, every mutant cargo-mutants lists with no exclusion applied.
 * @param {{ regex: string, literal: boolean, reason: string }[]} entries
 * @param {string[]} names
 * @param {number} [expected]
 * @returns {string[]}
 */
export function ledgerProblems(entries, names, expected = EXCLUSIONS) {
  /** @type {string[]} */
  const problems = []
  if (entries.length !== expected) {
    problems.push(
      `.cargo/mutants.toml holds ${entries.length} exclude_re entries, and rust-mutants.mjs pins ${expected}: change both in the diff that decides it`,
    )
  }
  for (const e of entries) {
    if (!e.literal) problems.push(`${e.regex}: write it as a single-quoted TOML literal`)
    if (e.reason.length < 20) problems.push(`${e.regex}: an exclusion with no reason above it`)
    let re
    try {
      re = new RegExp(e.regex)
    } catch (err) {
      problems.push(`${e.regex}: not a regex (${err.message})`)
      continue
    }
    if (!names.some((n) => re.test(n)))
      problems.push(`${e.regex}: matches no mutant, so it is stale`)
  }
  return problems
}

/**
 * The mutant names in `cargo mutants --list` output, one a line, with any
 * terminal colour stripped: a name the ledger is matched against must be the
 * plain text, whatever the environment asked the tool to draw.
 * @param {string} stdout
 * @returns {string[]}
 */
export function mutantNames(stdout) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: an ANSI escape is what is being stripped
  const ansi = /\u001b\[[0-9;]*m/g
  return stdout
    .split('\n')
    .map((l) => l.replace(ansi, '').trim())
    .filter((l) => l !== '')
}

/**
 * The `--shard` argument for a CI leg. Legs are numbered from 1 (the matrix,
 * and the job names `rust-mutants (1)`..`(n)`), cargo-mutants' shards from 0
 * (`0/n` to `n-1/n`), so leg k runs shard k-1: passing k through left shard 0
 * unrun and refused leg n.
 * @param {string | undefined} leg `k/n`, 1-based, or nothing for one unsharded run
 * @returns {string | undefined | Error}
 */
export function cargoShard(leg) {
  if (leg === undefined || leg === '') return undefined
  const m = /^(\d+)\/(\d+)$/.exec(leg)
  const k = Number(m?.[1])
  const n = Number(m?.[2])
  if (!m || k < 1 || k > n)
    return new Error(`RUST_MUTANTS_SHARD must be k/n with 1 <= k <= n, got ${leg}`)
  return `${k - 1}/${n}`
}
