/**
 * QR-14b and QR-14d for Rust: every property runs through the one prelude,
 * `crates/testing/proptest`, and nothing pins a seed.
 *
 * `deny.toml` already keeps proptest behind the prelude as a DEPENDENCY. What
 * it cannot see is code that reaches proptest through the prelude's
 * re-export and builds its own runner: a `ProptestConfig` with another
 * budget, a fixed `RngSeed`, or the `proptest!` macro, which skips the
 * prelude's `check` and so its reachability floor. And a seed pinned from
 * outside — `PROPTEST_RNG_SEED` in a workflow or a script — is not Rust at
 * all, so the workflows, the root manifest and the check scripts are read for
 * it too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rustCode, rustSourceFiles } from './rust-source.js'
import { REPO_ROOT, walk } from './scan-roots.js'

const PRELUDE = 'crates/testing/proptest/'

const BYPASSES: readonly { name: string; pattern: RegExp }[] = [
  { name: 'a ProptestConfig built outside the prelude', pattern: /\bProptestConfig\b/ },
  { name: "proptest's runner Config", pattern: /\btest_runner::Config\b/ },
  { name: 'a TestRunner built outside the prelude', pattern: /\bTestRunner\b/ },
  { name: 'the proptest! macro, which skips check()', pattern: /\bproptest!\s*[({[]/ },
  { name: 'a seed', pattern: /\brng_seed\b|\bRngSeed\b/ },
]

/** Every bypass in one file's code, comments and literals blanked first. */
function bypassesIn(code: string): string[] {
  return BYPASSES.filter((b) => b.pattern.test(code)).map((b) => b.name)
}

const SEED_ENV = /PROPTEST_RNG_SEED/

describe('the Rust proptest prelude is the only runner', () => {
  const files = rustSourceFiles().filter((f) => !f.startsWith(PRELUDE))
  const users = files.filter((f) =>
    /\bwhiteboard_proptest\b/.test(rustCode(readFileSync(join(REPO_ROOT, f), 'utf8'))),
  )

  it('reaches the properties it polices', () => {
    expect(users.length).toBeGreaterThan(0)
  })

  it('finds no runner, config, macro or seed outside the prelude', () => {
    const found = files.flatMap((f) =>
      bypassesIn(rustCode(readFileSync(join(REPO_ROOT, f), 'utf8'))).map((b) => `${f}: ${b}`),
    )
    expect(found).toEqual([])
  })

  it('fails each bypass it names, and not their mention in a comment', () => {
    const planted = [
      'let c = ProptestConfig::with_cases(10);',
      'use proptest::test_runner::Config;',
      'let mut r = TestRunner::default();',
      'proptest! { #[test] fn f(x in 0..1u8) {} }',
      'Config { rng_seed: RngSeed::Fixed(7), ..c }',
    ]
    for (const line of planted) expect(bypassesIn(rustCode(line)), line).not.toEqual([])
    expect(bypassesIn(rustCode('// a ProptestConfig is built in the prelude'))).toEqual([])
  })

  it('pins no seed from a workflow, the root manifest or a check script', () => {
    const scripts = walk(join(REPO_ROOT, 'tools/checks/src'), {
      include: (p) => p.endsWith('.mjs'),
    })
    const workflows = walk(join(REPO_ROOT, '.github'), {
      include: (p) => p.endsWith('.yml') || p.endsWith('.yaml'),
    })
    const read = [...scripts, ...workflows, join(REPO_ROOT, 'package.json')]
    expect(read.length).toBeGreaterThan(5)
    expect(read.filter((p) => SEED_ENV.test(readFileSync(p, 'utf8')))).toEqual([])
  })
})
