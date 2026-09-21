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

test('pathFromTestId strips the project, which is what git has to be asked about', () => {
  assert.equal(
    pathFromTestId('[web-browser (chromium)] src/x/a.browser.test.tsx'),
    'src/x/a.browser.test.tsx',
  )
  assert.equal(pathFromTestId('no project prefix'), null)
})

test('an entry whose file has MOVED since its newest failure is marked, not acted on blind', () => {
  // The case this exists for, as it really happened (2026-09-21): the window
  // still held two 09-12/09-13 failures of a touch-tap test whose root cause
  // had been found and fixed in seven commits on 09-21. The report said "Act
  // NOW" over a defect that no longer existed, and a session very nearly
  // spent a whole fix lane on it. git already knew.
  const window = [
    {
      runId: '34689951606',
      createdAt: '2026-09-12T11:01:24Z',
      titles: ['[web-browser (chromium)] src/x/wiki-link-completion.browser.test.tsx > a real touch tap'],
    },
    {
      runId: '34731509463',
      createdAt: '2026-09-13T01:50:05Z',
      titles: ['[web-browser (chromium)] src/x/wiki-link-completion.browser.test.tsx > a real touch tap'],
    },
  ]
  const inspect = (path, sinceIso) => {
    assert.equal(path, 'src/x/wiki-link-completion.browser.test.tsx')
    assert.equal(sinceIso, '2026-09-13T01:50:05Z')
    return {
      state: 'changed',
      commits: 7,
      newest: 'fix(web): a touch tap on a completion option is no longer dropped (#1692)',
    }
  }
  const report = formatReport(clusterFailures(window), 14, inspect)
  assert.match(report, /7 commit\(s\) have touched this file since/)
  // The newest subject is the whole point: it is what says "already fixed"
  // in one line, where a bare count only says "something happened".
  assert.match(report, /no longer dropped \(#1692\)/)
  assert.match(report, /verify the flake still reproduces/i)
})

test('a file nothing has touched since says so, and a deleted one says that', () => {
  const twice = (file) => [
    { runId: '1', createdAt: '2026-09-01T00:00:00Z', titles: [`[p] ${file} > x`] },
    { runId: '2', createdAt: '2026-09-02T00:00:00Z', titles: [`[p] ${file} > x`] },
  ]
  const still = formatReport(clusterFailures(twice('src/a.test.ts')), 14, () => ({
    state: 'unchanged',
  }))
  assert.match(still, /nothing has touched this file since/)
  assert.doesNotMatch(still, /verify the flake still reproduces/i)

  const gone = formatReport(clusterFailures(twice('src/b.test.ts')), 14, () => ({
    state: 'missing',
  }))
  assert.match(gone, /this file no longer exists/)
})

test('no inspector, or one that throws, reports exactly what it did before', () => {
  // Fail-open, like the script around it: a machine without git history, a
  // shallow clone, or a path the resolver cannot place must not turn a
  // session start into an error or a false "nothing has changed".
  const window = [
    { runId: '1', createdAt: '2026-09-01T00:00:00Z', titles: ['[p] src/a.test.ts > x'] },
    { runId: '2', createdAt: '2026-09-02T00:00:00Z', titles: ['[p] src/a.test.ts > x'] },
  ]
  const bare = formatReport(clusterFailures(window), 14)
  const threw = formatReport(clusterFailures(window), 14, () => {
    throw new Error('not a git repository')
  })
  assert.equal(threw, bare)
  assert.doesNotMatch(bare, /touched this file|no longer exists/)
})

test('an unhandled error with no test name is keyed by its class and path, not dropped', () => {
  // The tenth shape in integrator-flow.md: `EnvironmentTeardownError`
  // reports every test as PASSED and exits 1, and its annotation title is
  // the bare string "Unhandled error" — no project, no test file — so it
  // used to land in `unattributedRuns` and be counted rather than keyed.
  // It was hand-counted to three occurrences before anything could see it.
  //
  // The annotation does carry a PATH, and the message opens with the error
  // class. Those two together are the surface, and two runs sharing them
  // are the same flake by the same rule as any other.
  //
  // The title, path and message below are copied from a real annotation —
  // run 35658804336, PR #1811's `test-jsdom (1)` — rather than invented,
  // because what this parser has to match is a string GitHub produces.
  const teardown = (runId, createdAt) => ({
    runId,
    createdAt,
    annotations: [
      {
        title: 'Unhandled error',
        path: 'apps/web/src/lib/replica-unlock.ts',
        message:
          "EnvironmentTeardownError: Cannot load '/@fs/.../replica-key-wrap.ts' imported from .../replica-unlock.ts after the environment was torn down.",
      },
      { title: '', path: '.github', message: 'Process completed with exit code 1.' },
    ],
  })
  const { recurrences, unattributedRuns } = clusterFailures([
    teardown('1', '2026-09-20T00:00:00Z'),
    teardown('2', '2026-09-22T00:00:00Z'),
  ])

  assert.deepEqual(unattributedRuns, [])
  assert.equal(recurrences.length, 1)
  assert.match(recurrences[0].id, /EnvironmentTeardownError/)
  assert.match(recurrences[0].id, /apps\/web\/src\/lib\/replica-unlock\.ts/)
  assert.equal(recurrences[0].runIds.length, 2)
})

test('an unhandled error asks git about the file it NAMES, which is not a test file', () => {
  const run = (runId, createdAt) => ({
    runId,
    createdAt,
    annotations: [
      {
        title: 'Unhandled error',
        path: 'apps/web/src/lib/replica-unlock.ts',
        message: 'EnvironmentTeardownError: Cannot load ... after the environment was torn down.',
      },
    ],
  })
  let asked = null
  const report = formatReport(clusterFailures([run('1', '2026-09-20T00:00:00Z'), run('2', '2026-09-22T00:00:00Z')]), 14, (path) => {
    asked = path
    return { state: 'unchanged' }
  })

  assert.equal(asked, 'apps/web/src/lib/replica-unlock.ts')
  assert.match(report, /nothing has touched this file since/)
})

test('two unhandled errors of DIFFERENT classes at one path are two surfaces', () => {
  const at = (runId, createdAt, message) => ({
    runId,
    createdAt,
    annotations: [{ title: 'Unhandled error', path: 'src/a.ts', message }],
  })
  const { recurrences, singles } = clusterFailures([
    at('1', '2026-09-20T00:00:00Z', 'EnvironmentTeardownError: torn down'),
    at('2', '2026-09-21T00:00:00Z', 'TypeError: x is not a function'),
  ])

  assert.deepEqual(recurrences, [])
  assert.equal(singles.length, 2)
})

test('a run whose annotations name a TEST is keyed by the test, unhandled errors beside it or not', () => {
  // Precedence, so the shape a lane can act on wins: a real test failure is
  // a better identity than the unhandled error it may also have produced.
  const { recurrences, singles } = clusterFailures([
    {
      runId: '1',
      createdAt: '2026-09-20T00:00:00Z',
      annotations: [
        { title: '[p] src/a.test.ts > x fails', path: 'src/a.test.ts', message: 'AssertionError' },
        { title: 'Unhandled error', path: 'src/b.ts', message: 'TypeError: nope' },
      ],
    },
  ])

  assert.deepEqual(recurrences, [])
  assert.deepEqual(singles.map((entry) => entry.id), ['[p] src/a.test.ts'])
})

test('a window that supplies bare titles still clusters, cache shape or no cache shape', () => {
  // `titles` is the older caller shape and the one every fixture above uses.
  // Keeping it is not politeness: the lib is what the tests replay the real
  // 2026-08/09 window through, and that window is titles.
  const { recurrences } = clusterFailures([
    { runId: '1', createdAt: '2026-09-01T00:00:00Z', titles: ['[p] src/a.test.ts > x'] },
    { runId: '2', createdAt: '2026-09-02T00:00:00Z', titles: ['[p] src/a.test.ts > x'] },
  ])

  assert.equal(recurrences.length, 1)
  assert.equal(recurrences[0].id, '[p] src/a.test.ts')
})

test('an unattributed run is reported by the LEG it failed, and never as a recurrence', () => {
  // Measured on the real 14-day window while this was written: all four
  // unattributed runs carried nothing but the runner's own empty-title
  // "Process completed with exit code 1." and ci-gate's own summary
  // annotation, `[ci-gate] <leg>: failure`. That names WHICH leg died and
  // nothing about why.
  //
  // So it is printed and NOT keyed. Two runs that both failed
  // `test-unit (2)` are not the same flake, and this report's tail tells a
  // session to spend a fix lane — the one thing worse than an uncountable
  // failure is a false promotion signal, which this file's own history
  // already cost once.
  const legRun = (runId, createdAt, leg) => ({
    runId,
    createdAt,
    annotations: [
      { title: '', path: '.github', message: 'Process completed with exit code 1.' },
      { title: '', path: '.github', message: `[ci-gate] ${leg}: failure` },
    ],
  })
  const clustered = clusterFailures([
    legRun('1', '2026-09-20T00:00:00Z', 'test-unit (2)'),
    legRun('2', '2026-09-21T00:00:00Z', 'test-unit (2)'),
    legRun('3', '2026-09-22T00:00:00Z', 'test-jsdom (1)'),
  ])

  assert.deepEqual(clustered.recurrences, [])
  assert.equal(clustered.unattributedRuns.length, 3)

  // A recurrence is needed for the report to print at all.
  const report = formatReport(
    clusterFailures([
      { runId: 'a', createdAt: '2026-09-01T00:00:00Z', titles: ['[p] src/a.test.ts > x'] },
      { runId: 'b', createdAt: '2026-09-02T00:00:00Z', titles: ['[p] src/a.test.ts > x'] },
      ...[legRun('1', '2026-09-20T00:00:00Z', 'test-unit (2)'),
          legRun('2', '2026-09-21T00:00:00Z', 'test-unit (2)'),
          legRun('3', '2026-09-22T00:00:00Z', 'test-jsdom (1)')],
    ]),
    14,
  )
  assert.match(report, /2x test-unit \(2\)/)
  assert.match(report, /1x test-jsdom \(1\)/)
  assert.doesNotMatch(report, /2x test-unit \(2\)[\s\S]*promotion signal/)
})

test('a leg is read off an annotation with an EMPTY title, which is the only kind that has one', () => {
  // The fetcher dropped every empty-title annotation, so the leg never
  // reached the clusterer at all and the report printed nothing new. Unit
  // tests could not see it: they supply annotations the fetcher never
  // touched. Found by running the real window.
  assert.equal(
    failedLegFrom({ title: '', path: '.github', message: '[ci-gate] test-unit (2): failure' }),
    'test-unit (2)',
  )
  assert.equal(failedLegFrom({ title: '', path: '.github', message: 'Process completed with exit code 1.' }), null)
  assert.equal(failedLegFrom({}), null)
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

import { failedLegFrom, formatReport, pathFromTestId } from './flake-watch-lib.mjs'
