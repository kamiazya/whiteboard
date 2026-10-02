#!/usr/bin/env node
// Type-checks the package's test files (usage: typecheck-tests.mjs
// <tsconfig> [--ratchet]).
//
// Why a ledger rather than a clean program: the test files were checked
// nowhere before this ran, so some already disagree with the production types
// they call. Those files are listed in typecheck-tests-debt.json with the
// error codes each carries, and the program must reproduce that exactly: an
// error anywhere else is new, an error swapped for a different one is new, and
// a file that carries fewer than recorded (or none) must be lowered in the
// ledger, so the debt only falls.
// `--ratchet` rewrites the ledger from the current run and refuses to record
// anything that grew.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareToLedger, parseDiagnostics, ratchetLedger } from './typecheck-tests-lib.mjs'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER_PATH = resolve(PACKAGE_ROOT, 'scripts', 'typecheck-tests-debt.json')

function readLedger() {
  const { files } = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'))
  const unlisted = Object.entries(files).filter(([, codes]) => !Array.isArray(codes))
  if (unlisted.length > 0) {
    // The count-only shape could not see a swapped error. A ledger merged in
    // from a branch that still writes it cannot be read, and re-recording it
    // by hand would be re-recording debt without looking at it.
    console.error(
      `typecheck-tests-debt.json records a count, not a list of error codes, for ${unlisted
        .map(([file]) => file)
        .join(', ')}. Take the ledger from the branch that records codes and run the ratchet.`,
    )
    process.exit(2)
  }
  return files
}

function writeLedger(files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(LEDGER_PATH, `${JSON.stringify({ files: sorted }, null, 2)}\n`)
}

function main() {
  const [tsconfig, ...flags] = process.argv.slice(2)
  if (!tsconfig) {
    console.error('usage: typecheck-tests.mjs <tsconfig> [--ratchet]')
    return 2
  }
  // The package's own compiler, not whichever `tsc` is first on PATH.
  const tsc = resolve(
    dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    'bin',
    'tsc',
  )
  const run = spawnSync(process.execPath, [tsc, '-p', tsconfig, '--noEmit', '--pretty', 'false'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (run.error) {
    console.error(`could not run tsc: ${run.error.message}`)
    return 2
  }
  const output = `${run.stdout}${run.stderr}`
  const { byFile, unattributed } = parseDiagnostics(output)
  if (unattributed.length > 0) {
    console.error(`tsc reported errors that name no file:\n${unattributed.join('\n')}`)
    return 1
  }
  const ledger = readLedger()

  if (flags.includes('--ratchet')) {
    const result = ratchetLedger(byFile, ledger)
    if (!result.ok) {
      console.error('refusing to record: errors grew or appeared. Fix them instead.')
      report(result.verdict, output)
      return 1
    }
    writeLedger(result.ledger)
    console.error(`ledger now holds ${Object.keys(result.ledger).length} file(s)`)
    return 0
  }

  const verdict = compareToLedger(byFile, ledger)
  if (!verdict.failed) {
    const owed = [...byFile.values()].reduce((total, codes) => total + codes.length, 0)
    console.error(
      `test typecheck: ${tsconfig} clean apart from ${byFile.size} ledgered file(s), ${owed} error(s)`,
    )
    return 0
  }
  report(verdict, output)
  return 1
}

const codesOf = (novel) =>
  novel.map(({ code, count, recorded }) => `${code} x${count} (was ${recorded})`).join(', ')

function report({ added, grew, swapped, shrunk, cleared }, output) {
  // The ledgered files' errors are known; the ones to read are the new ones.
  const offending = new Set([...added, ...grew, ...swapped].map(({ file }) => file))
  for (const line of output.split('\n')) {
    if ([...offending].some((file) => line.startsWith(`${file}(`))) console.error(line)
  }
  for (const { file, count } of added) {
    console.error(`new type errors in ${file} (${count}): fix them (the ledger takes no new files)`)
  }
  for (const { file, count, recorded, novel } of grew) {
    console.error(
      `${file} has ${count} type error(s), ledger records ${recorded}: fix the new ones (${codesOf(novel)})`,
    )
  }
  for (const { file, novel } of swapped) {
    console.error(
      `${file} carries an error the ledger does not owe, in place of one it does: ${codesOf(novel)}. Fix the new one.`,
    )
  }
  for (const { file, count, recorded } of shrunk) {
    console.error(
      `${file} has ${count} type error(s), ledger records ${recorded}: run \`pnpm --filter @kamiazya/whiteboard-mcp typecheck:tests:ratchet\``,
    )
  }
  for (const { file } of cleared) {
    console.error(`${file} no longer has type errors: run the ratchet to drop it from the ledger`)
  }
}

process.exit(main())
