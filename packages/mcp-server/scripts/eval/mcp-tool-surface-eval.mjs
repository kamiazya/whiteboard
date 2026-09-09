#!/usr/bin/env node
// The LLM-driven lane of the tool-surface eval (ADR-0031).
//
// Seeds a fixture workspace through the real MCP server, then hands each
// task in tasks.mjs to a real model through the claude CLI with ONLY this
// server's tools available, from an empty working directory so nothing but
// the server's own instructions and tool table reaches the model. Each task
// runs on its own copy of the seeded data, so tasks cannot see each other.
//
// Reports, per task: the verdict (by outcome), the tool calls it took and
// which tools, tool errors the model had to recover from, tokens, cost and
// wall time. Across trials: pass@k and pass^k.
//
// This consumes API quota, so it is not part of `pnpm test` and skips
// cleanly where no claude CLI is installed. Manual use, from this package:
//   node scripts/eval/mcp-tool-surface-eval.mjs [--trials=3] [--model=sonnet]
//     [--only=<substring>] [--out=<file.json>] [--dry-run]
// `--dry-run` seeds the fixture and runs every verifier against it WITHOUT
// calling a model: read tasks are checked to be answerable from the store
// and write tasks must FAIL on the untouched fixture, or the verifier is not
// measuring the write.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCliAvailable } from '../smoke/lib/cli-available.mjs'
import { seed, WORKSPACE_ID } from './fixture.mjs'
import { connectWhiteboard, LAUNCHER } from './lib/whiteboard-client.mjs'
import { TASKS } from './tasks.mjs'

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found === undefined ? fallback : found.slice(name.length + 3)
}
const flag = (name) => process.argv.includes(`--${name}`)

const TRIALS = Number(arg('trials', '1'))
const MODEL = arg('model', undefined)
const ONLY = arg('only', undefined)
const OUT = arg('out', undefined)
const DRY_RUN = flag('dry-run')
const MAX_TURNS = arg('max-turns', '15')
const MAX_BUDGET_USD = arg('max-budget-usd', '1')
const TASK_TIMEOUT_MS = 240_000

const tasks = ONLY === undefined ? TASKS : TASKS.filter((t) => t.name.includes(ONLY))
if (tasks.length === 0) {
  console.error(`[eval] no task matches --only=${ONLY}`)
  process.exit(2)
}

const scratch = mkdtempSync(join(tmpdir(), 'whiteboard-tool-surface-eval-'))
const template = join(scratch, 'template')
const cleanup = () => rmSync(scratch, { recursive: true, force: true })

console.log('[eval] seeding the fixture workspace')
const seeded = await connectWhiteboard(template)
const ids = await seed(seeded)
await seeded.close()

if (DRY_RUN) {
  let failed = 0
  for (const task of tasks) {
    if (task.verify === undefined) continue
    const dir = join(scratch, `dry-${tasks.indexOf(task)}`)
    cpSync(template, dir, { recursive: true })
    const wb = await connectWhiteboard(dir)
    const verdict = await task.verify(wb, ids)
    await wb.close()
    // The fixture is untouched, so a verifier that passes here would pass
    // a model that did nothing.
    const line = verdict.ok ? 'FAIL (passes on the untouched fixture)' : 'ok (fails as it should)'
    if (verdict.ok) failed += 1
    console.log(`[eval] verifier "${task.name}": ${line} — ${verdict.detail}`)
  }
  console.log(
    `[eval] read tasks: ${tasks.filter((t) => t.answer !== undefined).length}, write tasks verified: ${tasks.filter((t) => t.verify !== undefined).length}`,
  )
  cleanup()
  process.exit(failed === 0 ? 0 : 1)
}

if (!isCliAvailable('claude')) {
  console.log(
    '[eval] SKIP: claude CLI not found on PATH — this lane needs a local claude install and API quota',
  )
  cleanup()
  process.exit(0)
}

const ANSWER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
})

const normalise = (s) =>
  String(s ?? '')
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, '')
    .toLowerCase()

/**
 * One task, one trial: a fresh copy of the fixture, a fresh CLI session.
 * @returns {Promise<Record<string, unknown>>}
 */
async function runOnce(task, trial) {
  const dir = join(scratch, `t${tasks.indexOf(task)}-${trial}`)
  cpSync(template, dir, { recursive: true })
  // Empty on purpose: a checkout here would put this repo's own
  // instructions, which name the tools, in front of the model.
  const cwd = join(dir, 'cwd')
  mkdirSync(cwd)
  const config = join(dir, 'mcp.json')
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        whiteboard: {
          type: 'stdio',
          command: process.execPath,
          args: [LAUNCHER],
          env: { WHITEBOARD_DATA_DIR: join(dir, 'data'), WHITEBOARD_NO_WATCH: '1' },
        },
      },
    }),
  )
  // The fixture was seeded under `template` itself; the copy keeps that
  // layout, so the server's data dir is the copy's root.
  rmSync(join(dir, 'data'), { recursive: true, force: true })
  cpSync(template, join(dir, 'data'), { recursive: true })

  const prompt = [
    `You have the whiteboard MCP server. The workspace is "${WORKSPACE_ID}".`,
    task.prompt,
    task.answer === undefined
      ? 'When done, answer with a one-line summary of what you changed.'
      : 'Reply with the answer only, no explanation.',
  ].join('\n')

  const args = [
    '-p',
    prompt,
    '--mcp-config',
    config,
    '--strict-mcp-config',
    // Only this server's tools, so a built-in cannot reach the data dir
    // around the tool surface under test.
    '--tools',
    '',
    '--allowedTools',
    'mcp__whiteboard',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--session-id',
    randomUUID(),
    '--max-turns',
    MAX_TURNS,
    '--max-budget-usd',
    MAX_BUDGET_USD,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(task.answer === undefined ? [] : ['--json-schema', ANSWER_SCHEMA]),
    ...(MODEL === undefined ? [] : ['--model', MODEL]),
  ]

  const started = Date.now()
  const events = await new Promise((resolvePromise) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), TASK_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, parsed: [], stderr: String(error) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const lines = stdout.split('\n').filter((l) => l.trim() !== '')
      const parsed = []
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line))
        } catch {
          /* progress noise */
        }
      }
      resolvePromise({ code, parsed, stderr })
    })
  })

  const calls = []
  const inputs = []
  const errorTexts = []
  let result
  for (const event of events.parsed) {
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use' && block.name !== 'StructuredOutput') {
          const name = block.name.replace(/^mcp__whiteboard__/, '')
          // A batch tool's cost is decided by which arm the model picked,
          // and the tool name alone cannot say: record `ops[].op` beside it.
          const ops = Array.isArray(block.input?.ops)
            ? block.input.ops.map((o) => o?.op).filter((o) => typeof o === 'string')
            : []
          calls.push(ops.length > 0 ? `${name}[${ops.join(',')}]` : name)
          // The payload itself goes to `--out` only: whether a model
          // declared geometry or left it to placement is the kind of
          // question a before/after on a shape has to answer.
          inputs.push({ tool: name, input: block.input })
        }
      }
    } else if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        // What the tool said back is the C11 evidence: which parameter
        // the model got wrong, and whether the refusal told it how to fix it.
        if (block.type === 'tool_result' && block.is_error === true) {
          const text = Array.isArray(block.content)
            ? block.content.map((c) => c.text ?? '').join(' ')
            : String(block.content ?? '')
          errorTexts.push(text.slice(0, 240))
        }
      }
    } else if (event.type === 'result') {
      result = event
    }
  }

  let verdict
  if (task.answer !== undefined) {
    const answered =
      result?.structured_output?.answer ??
      String(result?.result ?? '')
        .split('\n')
        .at(-1)
    const got = normalise(answered)
    const want = normalise(task.answer)
    const exact = got === want
    const loose = !exact && got.includes(want) && got.length <= want.length * 3
    verdict = {
      ok: exact || loose,
      detail: exact
        ? `answered "${answered}"`
        : loose
          ? `loosely: "${answered}"`
          : `answered "${answered}", wanted "${task.answer}"`,
    }
  } else {
    const wb = await connectWhiteboard(join(dir, 'data'))
    try {
      verdict = await task.verify(wb, ids)
      // What the board LOOKS like after a write task is evidence the
      // verdict cannot carry: a layout can pass every property and still
      // read badly. Rendered through the same pipeline a person sees,
      // beside `--out`, one SVG per board the task names.
      if (OUT !== undefined && Array.isArray(task.boards)) {
        const listed = await wb.call('wb_document_list', { workspaceId: WORKSPACE_ID })
        for (const path of task.boards) {
          const entry = listed.documents.find((d) => d.path === path)
          if (entry === undefined) continue
          const rendered = await wb.call('wb_scene_render', {
            workspaceId: WORKSPACE_ID,
            documentId: entry.documentId,
          })
          const figures = `${OUT.replace(/\.json$/, '')}-boards`
          mkdirSync(figures, { recursive: true })
          const file = `${task.name}-${trial}-${path}`.replace(/[^a-z0-9]+/gi, '-')
          writeFileSync(join(figures, `${file}.svg`), rendered.svg)
        }
      }
    } finally {
      await wb.close()
    }
  }

  const usage = result?.usage ?? {}
  return {
    task: task.name,
    trial,
    ok: verdict.ok,
    detail: verdict.detail,
    exitCode: events.code,
    calls: calls.length,
    tools: calls,
    inputs,
    toolErrors: errorTexts.length,
    toolErrorTexts: errorTexts,
    turns: result?.num_turns ?? null,
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    costUsd: result?.total_cost_usd ?? null,
    durationMs: Date.now() - started,
    stderr: events.stderr.trim() === '' ? undefined : events.stderr.trim().slice(-2000),
  }
}

const runs = []
for (const task of tasks) {
  for (let trial = 1; trial <= TRIALS; trial += 1) {
    const run = await runOnce(task, trial)
    runs.push(run)
    const mark = run.ok ? 'PASS' : 'FAIL'
    console.log(
      `[eval] ${mark} ${task.name} (trial ${trial}): ${run.calls} calls [${run.tools.join(' ')}], ${run.toolErrors} tool errors, ${run.turns} turns, $${(run.costUsd ?? 0).toFixed(3)}, ${(run.durationMs / 1000).toFixed(0)}s — ${run.detail}`,
    )
    for (const text of run.toolErrorTexts) console.log(`[eval]   tool error: ${text}`)
    if (run.exitCode !== 0 && run.stderr)
      console.log(`[eval]   stderr: ${run.stderr.split('\n').at(-1)}`)
  }
}

const byTask = new Map()
for (const run of runs) {
  const entry = byTask.get(run.task) ?? { passes: 0, trials: 0, calls: 0 }
  entry.trials += 1
  entry.calls += run.calls
  if (run.ok) entry.passes += 1
  byTask.set(run.task, entry)
}
const summary = {
  model: MODEL ?? 'cli default',
  trials: TRIALS,
  tasks: tasks.length,
  passAt1: runs.filter((r) => r.ok).length / runs.length,
  // pass@k: the task passed in at least one trial. pass^k: in every trial.
  passAtK: [...byTask.values()].filter((t) => t.passes > 0).length / byTask.size,
  passPowK: [...byTask.values()].filter((t) => t.passes === t.trials).length / byTask.size,
  meanCalls: runs.reduce((n, r) => n + r.calls, 0) / runs.length,
  toolErrors: runs.reduce((n, r) => n + r.toolErrors, 0),
  totalCostUsd: runs.reduce((n, r) => n + (r.costUsd ?? 0), 0),
  toolsUsed: Object.fromEntries(
    [
      ...runs.flatMap((r) => r.tools).reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map()),
    ].sort(),
  ),
}
console.log('[eval] summary', JSON.stringify(summary, null, 2))
if (OUT !== undefined) {
  writeFileSync(OUT, JSON.stringify({ summary, runs }, null, 2))
  console.log(`[eval] wrote ${OUT}`)
}
cleanup()
process.exit(0)
