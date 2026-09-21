// @vitest-environment node
/**
 * Every refusal a route writes as an object literal is IN the contract.
 *
 * `apiErrorBodySchema` (daemon-client) is the declared single source, and
 * every client-side reader goes through `apiErrorReason`. Nothing
 * CONSTRUCTED a body, so which slot meant what was up to each call site —
 * and both ways of getting it wrong typecheck, parse, and deliver nothing:
 *
 * - prose in the code slot (`{ error: 'malformed Origin header' }`), where
 *   `error` is then neither a token a client can switch on nor a reason
 *   `apiErrorReason` can return, since there is no `message`;
 * - the reason in a field outside the contract (`{ error: 'invalid input',
 *   issues: parsed.error.issues }`), which `apiErrorReason` discards whole.
 *
 * Measured when this was written: 98 refusal literals under `routes/`, of
 * which 26 were one of those two shapes, across `pairing.ts` (18),
 * `runtime.ts` (3), `membership.ts` (3) and `document/versions.ts` (2).
 * `pairing.ts` already had a local `refuse(error, message)` helper doing it
 * correctly for ONE endpoint while eighteen call sites in the same file did
 * not — which is the whole argument for a constructor rather than a habit.
 *
 * A SOURCE scan rather than a behavioural one, because it is total: the
 * routes fuzz lane can only judge a refusal it manages to provoke, and the
 * branch nobody reached is exactly the one that rots. Its runtime half
 * (`app.routes.fuzz.property.test.ts` parses every 4xx/5xx body under the
 * contract) catches what a literal cannot show — a body built from
 * variables.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apiErrorBodySchema } from '@kamiazya/whiteboard-server-core'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(__dirname, '../../../../..')

/**
 * Every place a daemon HTTP refusal is written: this package's routers, and
 * server-core's `/api/v1`.
 *
 * server-core was outside the first version of this scan and had the same
 * defect untouched — all 19 of its refusal literals were out of contract,
 * nine carrying a raw `issues` array and ten putting an EXCEPTION's message
 * in the code slot. A guard scoped to one package reported the other as
 * satisfied by never looking.
 */
const SCAN_ROOTS = [__dirname, join(REPO_ROOT, 'packages/server-core/src')]

function routeSources(dir: string, root: string): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeSources(full, root))
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      out.push({ file: full.slice(root.length + 1), source: readFileSync(full, 'utf8') })
    }
  }
  return out
}

/**
 * Every `c.json(body, status)` whose status is a refusal, with its body as
 * source text.
 *
 * Parentheses are BALANCED rather than matched with a regex. A non-greedy
 * `c.json\(([\s\S]*?),\s*(\d{3})\)` looks right and is not: measured while
 * writing this, it reported 154 refusal sites where the file holds 98,
 * because it happily runs past a nested call's own arguments. A guard built
 * on a probe that over-counts reads as thorough.
 */
function refusalCalls(file: string, source: string) {
  const found: { file: string; line: number; body: string; status: number }[] = []
  const CALL = 'c.json('
  for (let at = source.indexOf(CALL); at !== -1; at = source.indexOf(CALL, at + 1)) {
    const open = at + CALL.length
    let depth = 1
    let i = open
    const commas: number[] = []
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i]
      if (ch === '(' || ch === '{' || ch === '[') depth++
      else if (ch === ')' || ch === '}' || ch === ']') depth--
      else if (ch === ',' && depth === 1) commas.push(i)
    }
    if (depth !== 0 || commas.length === 0) continue
    const close = i - 1
    const lastComma = commas[commas.length - 1] ?? open
    const tail = source.slice(lastComma + 1, close).trim()
    const statusArg =
      tail === '' ? source.slice((commas[commas.length - 2] ?? open) + 1, lastComma).trim() : tail
    const status = Number(statusArg)
    if (!Number.isInteger(status) || status < 400) continue
    const bodyEnd = tail === '' ? (commas[commas.length - 2] ?? open) : lastComma
    found.push({
      file,
      line: source.slice(0, at).split('\n').length,
      body: source.slice(open, bodyEnd).trim(),
      status,
    })
  }
  return found
}

/** The object literal's keys, and its `error` value when that is a string literal. */
function shapeOf(body: string): { keys: string[]; errorValue: string | undefined } {
  // Shorthand counts: `{ error, message }` is the correct shape written the
  // short way, and reading it as an empty object would flag the one call site
  // that was already right.
  const keys = [...body.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(:|,|\})/g)].map(
    (m) => m[1] ?? '',
  )
  const error = /\berror:\s*'([^']*)'/.exec(body)
  return { keys, errorValue: error?.[1] }
}

/** A body written as an object literal here, rather than built by `errorBody`. */
function isLiteral(body: string): boolean {
  return body.startsWith('{') && body.endsWith('}') && !body.slice(1, -1).includes('{')
}

const REFUSALS = SCAN_ROOTS.flatMap((root) =>
  routeSources(root, root).flatMap(({ file, source }) => refusalCalls(file, source)),
)
const LITERALS = REFUSALS.filter((r) => isLiteral(r.body))

describe('every refusal literal a route writes is in the api error contract', () => {
  it('found a plausible number of refusals, across the routers', () => {
    // Both halves, and the TOTAL rather than the literal subset: as call
    // sites move to `errorBody` the literals dwindle, so a floor on them
    // alone would one day be a scan of nothing reporting perfect compliance.
    expect(REFUSALS.length).toBeGreaterThan(80)
    expect(new Set(REFUSALS.map((r) => r.file)).size).toBeGreaterThan(5)
    // And the constructor is really being used, so the two checks below are
    // not the whole story about what a route answers.
    expect(REFUSALS.length - LITERALS.length).toBeGreaterThan(20)
  })

  it('carries no field the contract does not name', () => {
    const outside = LITERALS.filter(
      (l) =>
        !apiErrorBodySchema.safeParse(
          Object.fromEntries(
            shapeOf(l.body).keys.map((k) => [k, k === 'error' ? 'placeholder_code' : 'x']),
          ),
        ).success,
    ).map((l) => `${l.file}:${l.line} {${shapeOf(l.body).keys.join(', ')}}`)
    expect(outside, 'a reason written where no client reads it').toEqual([])
  })

  it('puts a snake_case CODE in the error slot, never a sentence', () => {
    const prose = LITERALS.filter((l) => {
      const value = shapeOf(l.body).errorValue
      return value !== undefined && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value)
    }).map((l) => `${l.file}:${l.line} error: '${shapeOf(l.body).errorValue}'`)
    expect(prose, 'prose in the code slot reaches no reader').toEqual([])
  })
})
