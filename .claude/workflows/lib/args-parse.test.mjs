// Run with: node --test .claude/workflows/lib/args-parse.test.mjs
//
// Every workflow receives `args` as a JSON string and parses it in one IIFE at the top of the
// file. That parse used to swallow a SyntaxError and fall back to `{}`, which is the worst
// possible failure: the workflow does not stop, it runs to completion against empty inputs.
// A dev-loop launched with one unescaped quote in its spec became `taskTitle: 'untitled task'`
// with an empty body and still spent four agents before concluding no spec had been supplied.
//
// Malformed args is a caller bug with no sane default, so it must throw. The other three
// shapes still have to behave: a valid JSON string parses, an object passes through, and an
// absent `args` is a legitimate "no arguments" call.
//
// The workflow sandbox has no `import`, so each workflow carries its own copy of the parser.
// This test extracts every copy and runs the same four checks against all of them, so a new
// workflow that reintroduces the silent fallback fails here.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workflowDir = path.join(__dirname, '..')

const WORKFLOWS = readdirSync(workflowDir)
  .filter((f) => f.endsWith('.workflow.mjs'))
  .sort()

// Guards against this test silently covering nothing if the directory layout changes.
test('there are workflow files to check', () => {
  assert.ok(WORKFLOWS.length >= 10, `expected the workflow set, found ${WORKFLOWS.length}`)
})

function extractArgsParser(file) {
  const source = readFileSync(path.join(workflowDir, file), 'utf8')
  const match = source.match(/\nconst A = (\(\(\) => \{[\s\S]*?\n\}\)\(\))\n/)
  assert.ok(match, `could not locate the \`const A = (() => {...})()\` args parser in ${file}`)
  // Evaluating our own source with `args` injected, not untrusted input
  return new Function('args', `return ${match[1]}`)
}

for (const file of WORKFLOWS) {
  test(`${file}: parses a valid args JSON string`, () => {
    const parse = extractArgsParser(file)
    assert.deepEqual(parse('{"taskTitle":"x","n":1}'), { taskTitle: 'x', n: 1 })
  })

  test(`${file}: passes an object through unchanged`, () => {
    const parse = extractArgsParser(file)
    const obj = { taskTitle: 'x' }
    assert.equal(parse(obj), obj)
  })

  test(`${file}: treats an absent args as no arguments`, () => {
    const parse = extractArgsParser(file)
    assert.deepEqual(parse(undefined), {})
    assert.deepEqual(parse(null), {})
  })

  test(`${file}: THROWS on malformed args instead of falling back to {}`, () => {
    const parse = extractArgsParser(file)
    // An unescaped double quote inside a string value — exactly what silently emptied a
    // dev-loop's spec — plus a plainly truncated object.
    assert.throws(() => parse('{"taskSpec":"he said "hi" to me"}'), /args/i)
    assert.throws(() => parse('{"taskTitle":'), /args/i)
  })
}
