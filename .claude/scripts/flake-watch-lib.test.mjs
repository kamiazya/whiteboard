#!/usr/bin/env node
// Regression coverage for flake-watch-lib.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// The fixture is the real thing: the sixteen main-CI failures of
// 2026-08-28..09-04, as their annotation titles actually read. One session
// classified that window by hand — downloading six job logs, stripping
// escape codes, grepping for FAIL lines — and integrator-flow.md's rule
// ("the second occurrence of the same flake promotes it to a root-cause fix
// lane") had no watcher: the two clusters below were each noticed only
// after someone chose to look. Run over this window, the clusterer must
// flag exactly those two and none of the singles.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clusterFailures, testIdFromTitle } from './flake-watch-lib.mjs'

/** run id -> the test-failure annotation titles that run produced. */
const WINDOW = [
  // edge-rules: three runs in one day (Aug 30), pre-#1146.
  {
    runId: '33304624859',
    createdAt: '2026-08-30T09:40:13Z',
    titles: [
      '[canvas-render-node] src/layout/edges/edge-rules.properties.test.ts > PENALTY_RULES: each rule writes only its declared tier slot > the domain makes every penalty rule contribute a nonzero term',
    ],
  },
  {
    runId: '33313408933',
    createdAt: '2026-08-30T13:09:29Z',
    titles: [
      '[canvas-render-node] src/layout/edges/edge-rules.properties.test.ts > PENALTY_RULES: each rule writes only its declared tier slot > the domain makes every penalty rule contribute a nonzero term',
    ],
  },
  {
    runId: '33321928991',
    createdAt: '2026-08-30T16:15:11Z',
    titles: [
      '[canvas-render-node] src/layout/edges/edge-rules.properties.test.ts > PENALTY_RULES: each rule writes only its declared tier slot > the domain makes every penalty rule contribute a nonzero term',
    ],
  },
  // backup-in-progress: twice, three days apart (Aug 30, Sep 2), pre-#1224.
  {
    runId: '33326341153',
    createdAt: '2026-08-30T17:49:46Z',
    titles: [
      '[mcp-node] src/server/store/backup-in-progress.test.ts > the backup-in-progress marker > stays valid across a pass longer than its own lifetime',
    ],
  },
  {
    runId: '33583802709',
    createdAt: '2026-09-02T02:35:50Z',
    titles: [
      '[mcp-node] src/server/store/backup-in-progress.test.ts > the backup-in-progress marker > stays valid across a pass longer than its own lifetime',
    ],
  },
  // The singles, one run each.
  {
    runId: '33554108510',
    createdAt: '2026-09-01T20:14:06Z',
    titles: [
      '[web-jsdom] src/pages/BrowserDocumentPage.dialog-outlives-document.test.tsx > a destructive dialog does not outlive its document',
    ],
  },
  {
    runId: '33696937710',
    createdAt: '2026-09-02T23:50:59Z',
    titles: [
      '[web-jsdom] src/components/markdown-editor/editor-verbs.model.property.test.ts > markdown editor verbs as a state machine over the caret line',
    ],
  },
  {
    runId: '33296982894',
    createdAt: '2026-08-30T06:28:51Z',
    titles: [
      '[web-jsdom] src/App.workspace-switch.test.tsx > browser workspace switch > rewrites an address the registry cannot resolve, and stays where it was',
    ],
  },
  // One run failing two files at once (mcp-node under load, Aug 28): both
  // are singles — a run is one occurrence, not two.
  {
    runId: '33173434367',
    createdAt: '2026-08-28T12:59:59Z',
    titles: [
      '[mcp-node] src/server/routes/branches.test.ts > POST branches > initializes tipFrontiers through the index',
      '[mcp-node] src/server/routes/ws.test.ts > handleWsUpgrade viewport replay > replays the most recent viewport_request',
    ],
  },
  // Infra failures produce no test annotation at all: the audit timeout and
  // the apt 403. They must be counted, separately, not dropped.
  { runId: '33822259235', createdAt: '2026-09-04T00:33:17Z', titles: [] },
  { runId: '33756341059', createdAt: '2026-09-03T12:38:11Z', titles: [] },
]

test('testIdFromTitle keys on project + file, dropping the case name', () => {
  assert.equal(
    testIdFromTitle(
      '[mcp-node] src/server/store/backup-in-progress.test.ts > the backup-in-progress marker > stays valid',
    ),
    '[mcp-node] src/server/store/backup-in-progress.test.ts',
  )
  // A title that is not a vitest test annotation (the runner's own
  // "Process completed with exit code 1" has an empty title) yields null.
  assert.equal(testIdFromTitle(''), null)
  assert.equal(testIdFromTitle('Process completed with exit code 1.'), null)
})

test('the real window clusters into exactly the two known recurrences', () => {
  const { recurrences, singles, unattributedRuns } = clusterFailures(WINDOW)
  assert.deepEqual(
    recurrences.map((entry) => ({ id: entry.id, runs: entry.runIds.length })),
    [
      { id: '[canvas-render-node] src/layout/edges/edge-rules.properties.test.ts', runs: 3 },
      { id: '[mcp-node] src/server/store/backup-in-progress.test.ts', runs: 2 },
    ],
  )
  assert.equal(singles.length, 5)
  assert.equal(unattributedRuns.length, 2)
})

test('recurrence counts distinct RUNS, so one bad run cannot promote itself', () => {
  // The same file failing twice inside one run (two shards, or a second
  // assertion) is one occurrence of the environment, not two of the flake.
  const { recurrences, singles } = clusterFailures([
    {
      runId: 'r1',
      createdAt: '2026-09-01T00:00:00Z',
      titles: ['[p] src/a.test.ts > one', '[p] src/a.test.ts > two'],
    },
  ])
  assert.deepEqual(recurrences, [])
  assert.equal(singles.length, 1)
})

test('recurrences are ordered most-occurrences-first, ties by most recent', () => {
  const { recurrences } = clusterFailures([
    { runId: 'r1', createdAt: '2026-09-01T00:00:00Z', titles: ['[p] src/a.test.ts > x'] },
    { runId: 'r2', createdAt: '2026-09-02T00:00:00Z', titles: ['[p] src/a.test.ts > x'] },
    { runId: 'r3', createdAt: '2026-09-03T00:00:00Z', titles: ['[p] src/b.test.ts > y'] },
    { runId: 'r4', createdAt: '2026-09-04T00:00:00Z', titles: ['[p] src/b.test.ts > y'] },
    { runId: 'r5', createdAt: '2026-09-05T00:00:00Z', titles: ['[p] src/b.test.ts > y'] },
  ])
  assert.deepEqual(
    recurrences.map((entry) => entry.id),
    ['[p] src/b.test.ts', '[p] src/a.test.ts'],
  )
})

test('an empty window reports nothing, not an empty-shaped something', () => {
  const { recurrences, singles, unattributedRuns } = clusterFailures([])
  assert.deepEqual(recurrences, [])
  assert.deepEqual(singles, [])
  assert.deepEqual(unattributedRuns, [])
})

test('the report ends by telling the session what to DO, not only what happened', () => {
  const report = formatReport(
    clusterFailures([
      { runId: '1', createdAt: '2026-09-01T00:00:00Z', titles: ['[p] a.test.ts > x'] },
      { runId: '2', createdAt: '2026-09-02T00:00:00Z', titles: ['[p] a.test.ts > x'] },
    ]),
    14,
  )
  assert.match(report, /Act on the >=2x entries NOW/)
  assert.match(report, /root-cause fix lane/)
})

import { formatReport } from './flake-watch-lib.mjs'
