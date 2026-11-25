// The ledger of mutants cargo-mutants does not judge (.cargo/mutants.toml,
// QR-17), read and checked. Its own module so a test can import it without
// running the gate: `rust-mutants.mjs` checks each entry against every mutant
// `cargo mutants --list` names, and arch-lint's rust-mutants-ledger.test.ts
// checks the file's shape on every change.

/** How many `exclude_re` entries .cargo/mutants.toml holds: a change is a decision made in the diff. */
const EXCLUSIONS = 101

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

/**
 * The globs of `.cargo/mutants-pr-exclude.txt`: one a line, `#` comments and
 * blank lines ignored.
 * @param {string} text
 * @returns {string[]}
 */
export function prExcludeGlobs(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
}

/**
 * What is wrong with the in-diff exclusions: a glob that is not a plain
 * repository path (a wildcard would hide files nobody listed), one repeated,
 * or one that names no file, which would outlive the code it excused.
 * @param {string[]} globs
 * @param {(path: string) => boolean} exists
 * @returns {string[]}
 */
export function prExcludeProblems(globs, exists) {
  /** @type {string[]} */
  const problems = []
  const seen = new Set()
  for (const g of globs) {
    if (!/^crates\/[\w./-]+\.rs$/.test(g)) problems.push(`${g}: not a path to one Rust source file`)
    else if (!exists(g)) problems.push(`${g}: names no file, so it is stale`)
    if (seen.has(g)) problems.push(`${g}: listed twice`)
    seen.add(g)
  }
  return problems
}

/** The legs main, a schedule and a merge queue always run, over the whole workspace. */
const MAX_SHARDS = 8

/**
 * The most legs one pull-request group fans out to. Higher than `MAX_SHARDS`
 * because a group's legs run only that group's tests: a crate most of the
 * workspace depends on (`whiteboard-det`) is judged by nearly every test, at
 * about 70-100 s a mutant, so 172 of them over eight legs is ~22 a leg and
 * runs past the job's 40-minute timeout; sixteen keeps a leg near eleven.
 */
const MAX_GROUP_LEGS = 16

/**
 * Mutants one leg is asked to judge before another leg is worth its fixed
 * cost, when each mutant is judged by every test in the workspace: every leg
 * repeats its test set's baseline run, so a leg for one or two mutants spends
 * more on the baseline than on judging. A group judged by fewer tests gets
 * proportionally more per leg (see `mutantsPerLeg`).
 */
const MUTANTS_PER_SHARD = 6

/**
 * One member of the Cargo workspace: its name, its directory from the
 * workspace root, and the workspace members it depends on by any kind of
 * dependency on any target (a dev-dependency is how a test crate sees the
 * crate it judges, and a wasm32-only edge is still an edge).
 * @typedef {{ name: string, dir: string, dependsOn: string[] }} Member
 */

/**
 * The workspace's members from `cargo metadata --no-deps --format-version 1`.
 * @param {{ workspace_root: string, packages: { name: string, manifest_path: string, dependencies: { name: string }[] }[] }} metadata
 * @returns {Member[]}
 */
export function workspaceMembers(metadata) {
  const root = metadata.workspace_root.replace(/\/+$/, '')
  const names = new Set(metadata.packages.map((p) => p.name))
  return metadata.packages.map((p) => {
    const manifestDir = p.manifest_path.slice(0, p.manifest_path.lastIndexOf('/'))
    return {
      name: p.name,
      dir: manifestDir.startsWith(`${root}/`) ? manifestDir.slice(root.length + 1) : manifestDir,
      dependsOn: [...new Set(p.dependencies.map((d) => d.name).filter((n) => names.has(n)))],
    }
  })
}

/**
 * The packages whose tests can observe a change to `name`: the package itself
 * and every workspace member that depends on it, directly or through others.
 * A test in any other member cannot call the mutated code, so running it
 * judges nothing.
 * @param {Member[]} members
 * @param {string} name
 * @returns {string[]} sorted
 */
function testSetOf(members, name) {
  const seen = new Set([name])
  for (let grew = true; grew; ) {
    grew = false
    for (const m of members) {
      if (!seen.has(m.name) && m.dependsOn.some((d) => seen.has(d))) {
        seen.add(m.name)
        grew = true
      }
    }
  }
  return [...seen].sort()
}

/**
 * The member a source file belongs to: the one whose directory is the longest
 * prefix of the path.
 * @param {Member[]} members
 * @param {string} file
 */
function owningMember(members, file) {
  /** @type {Member | undefined} */
  let best
  for (const m of members) {
    if (file.startsWith(`${m.dir}/`) && (best === undefined || m.dir.length > best.dir.length))
      best = m
  }
  return best
}

/** The file a `cargo mutants --list` line names: everything before `:line:column:`. */
function fileOf(name) {
  return /^(.+?):\d+:\d+:/.exec(name)?.[1]
}

/**
 * How many mutants one leg judges for a group tested by `testPackages` of the
 * workspace's `memberCount` members: the cost of a mutant scales with the tests
 * it runs, so a group judged by a tenth of the workspace carries ten times the
 * mutants per leg.
 *
 * ponytail: the number of test packages stands in for their running time; time
 * the packages if a group's legs ever disagree about how long they take.
 * @param {number} memberCount
 * @param {number} testPackages
 */
function mutantsPerLeg(memberCount, testPackages) {
  return Math.min(
    MAX_MUTANTS_PER_LEG,
    Math.ceil((MUTANTS_PER_SHARD * memberCount) / Math.max(1, testPackages)),
  )
}

/**
 * The most mutants one leg judges, whatever the ratio above gives. The ratio
 * reads a package count as a running time, and one package is not cheap when
 * its own tests are slow: `whiteboard-mcp`, tested by itself alone, drew 121
 * mutants onto one leg, each re-running byte-for-byte replays of recorded
 * daemon calls (tens of seconds a mutant), and the leg ran past the job's
 * 40-minute timeout. Forty keeps such a leg near twenty minutes at thirty
 * seconds a mutant.
 */
const MAX_MUTANTS_PER_LEG = 40

/**
 * One leg of the mutants job. `packages` is the package whose mutants it
 * judges and `tests` the packages whose tests judge them, space-separated;
 * both empty is the whole workspace on both sides. `leg` names the job and
 * `key` the report artifact, which cannot hold a `/`.
 * @typedef {{ leg: string, key: string, shard: string, packages: string, tests: string }} Leg
 */

/**
 * The legs of the mutants job, or `[]` when no leg is owed.
 *
 * Only a pull request is narrowed. Every other event runs eight legs over the
 * whole workspace, so what main judges never depends on a count. On a pull
 * request the mutants the diff lists are grouped by package, each group judged
 * by the tests that can observe it (the package and its transitive reverse
 * dependents) and sharded by its own size, and it fails closed: a list or a workspace graph that
 * could not be read, or a mutant in no member, is the full set, not zero. Zero
 * legs is reserved for the two answers that say nothing can be judged: the
 * scope does not reach the job, or the diff lists no mutant.
 * @param {{ event: string, scopeRuns: boolean, mutants: string[] | null, members: Member[] | null }} input
 * @returns {Leg[]}
 */
export function shardPlan({ event, scopeRuns, mutants, members }) {
  const full = () =>
    Array.from({ length: MAX_SHARDS }, (_, i) => {
      const shard = `${i + 1}/${MAX_SHARDS}`
      return {
        leg: shard,
        key: `workspace-${i + 1}of${MAX_SHARDS}`,
        shard,
        packages: '',
        tests: '',
      }
    })
  if (event !== 'pull_request') return full()
  if (!scopeRuns) return []
  if (!Array.isArray(mutants)) return full()
  if (mutants.length === 0) return []
  if (!Array.isArray(members) || members.length === 0) return full()

  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const name of mutants) {
    const owner = owningMember(members, fileOf(name) ?? '')
    if (owner === undefined) return full()
    counts.set(owner.name, (counts.get(owner.name) ?? 0) + 1)
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, count]) => {
      const tests = testSetOf(members, name)
      const legs = Math.min(
        MAX_GROUP_LEGS,
        Math.ceil(count / mutantsPerLeg(members.length, tests.length)),
      )
      const label = name.replace(/^whiteboard-/, '')
      return Array.from({ length: legs }, (_, i) => {
        const shard = `${i + 1}/${legs}`
        return {
          leg: `${shard} ${label}`,
          key: `${label}-${i + 1}of${legs}`,
          shard,
          packages: name,
          tests: tests.join(' '),
        }
      })
    })
}

/**
 * A space-separated package list from a leg, as the arguments to repeat after
 * a flag; an error for a name that is not a Cargo package name, since the
 * value reaches a command line.
 * @param {string | undefined} list
 * @returns {string[] | Error}
 */
export function packageList(list) {
  const names = (list ?? '').split(/\s+/).filter((n) => n !== '')
  const bad = names.find((n) => !/^[A-Za-z0-9_-]+$/.test(n))
  return bad === undefined ? names : new Error(`not a package name: ${bad}`)
}
