/**
 * An operator command's `--json` stdout is a scripting contract
 * (docs/how-to/self-host-with-docker.md), so nothing under `cli/` may print a
 * value no schema has parsed. The sink took `unknown`, and five outputs were
 * hand-typed interfaces beside it: a field a handler added or dropped reached
 * a script without a single check seeing it.
 *
 * Two rules, both over the production files of `packages/mcp-server/src/cli`:
 * - the sinks (`writeJsonObject`, `operatorJsonLine`) are called with a schema
 *   identifier first, the argument that makes the parse unskippable;
 * - `JSON.stringify` appears nowhere else, so a command cannot print around
 *   the sink. `operator-json.ts` owns the one stringification of an output.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const CLI_DIR = 'packages/mcp-server/src/cli'
const SINK_CALL =
  /(?<!function\s)\b(writeJsonObject|operatorJsonLine)\s*(?:<[^>(]*>)?\(\s*([^,)\s]*)/g
const SCHEMA_IDENTIFIER = /^(?:[A-Za-z_$][\w$]*\.)*(?:schema|[A-Za-z_$][\w$]*Schema)$/

/** Files that stringify something other than an output, each with the reason. */
const STRINGIFY_ALLOWLIST: Readonly<Record<string, string>> = {
  [`${CLI_DIR}/operator-json.ts`]:
    'the one place an output is stringified, after its schema parsed it',
  [`${CLI_DIR}/daemon-replica-posture.ts`]:
    'serialises the REQUEST body sent to the daemon, not an output',
}

function badSinkCalls(source: string): string[] {
  const stripped = stripCommentsAndStrings(source)
  return [...stripped.matchAll(SINK_CALL)]
    .filter((match) => !SCHEMA_IDENTIFIER.test(match[2] ?? ''))
    .map((match) => `${match[1]}(${match[2]}`)
}

function stringifies(source: string): boolean {
  return source
    .split('\n')
    .some((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line) && line.includes('JSON.stringify('))
}

const files = walkSourceFiles(join(REPO_ROOT, CLI_DIR)).filter((path) => !isTestPath(path))
const rel = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')

describe('operator --json output goes through a schema', () => {
  it('recognises a sink call whose first argument is not a schema', () => {
    expect(badSinkCalls('writeJsonObject(result)')).toEqual(['writeJsonObject(result'])
    expect(badSinkCalls('writeJsonObject(outcome.result)')).toEqual([
      'writeJsonObject(outcome.result',
    ])
    expect(badSinkCalls('operatorJsonLine(output, value)')).toEqual(['operatorJsonLine(output'])
    expect(badSinkCalls('writeJsonObject(\n  command.schema,\n  result,\n)')).toEqual([])
    expect(badSinkCalls('writeJsonObject(daemonStatusResultSchema, result)')).toEqual([])
    expect(badSinkCalls('operatorJsonLine<S>(output, value)')).toEqual(['operatorJsonLine(output'])
    expect(badSinkCalls('export function writeJsonObject(value: unknown): void {}')).toEqual([])
    expect(badSinkCalls('// writeJsonObject(result) in prose')).toEqual([])
  })

  it('scans a directory worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(files.length).toBeGreaterThan(30)
    const sinkCalls = files.flatMap((path) =>
      [...stripCommentsAndStrings(readFileSync(path, 'utf8'), path).matchAll(SINK_CALL)].map(
        () => 1,
      ),
    )
    expect(sinkCalls.length).toBeGreaterThan(15)
  })

  it('every writeJsonObject and operatorJsonLine call names a schema first', () => {
    const hits = files.flatMap((path) =>
      badSinkCalls(readFileSync(path, 'utf8')).map((call) => `${rel(path)}: ${call}`),
    )
    expect(
      hits,
      'an operator output is declared in operator-json.ts (or a shared contract) and printed through its schema, so a stray field is a crash in the command rather than a change in what a script reads',
    ).toEqual([])
  })

  it('nothing but the sink stringifies an output', () => {
    const hits = files
      .filter((path) => STRINGIFY_ALLOWLIST[rel(path)] === undefined)
      .filter((path) => stringifies(readFileSync(path, 'utf8')))
      .map(rel)
    expect(hits, 'print through operatorJsonLine so the schema parses what is written').toEqual([])
  })

  it('every stringify allowlist entry still stringifies', () => {
    const stale = Object.keys(STRINGIFY_ALLOWLIST).filter((entry) => {
      try {
        return !stringifies(readFileSync(join(REPO_ROOT, entry), 'utf8'))
      } catch {
        return true
      }
    })
    expect(stale).toEqual([])
  })
})
