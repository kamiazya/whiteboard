// Run with: node --test .claude/workflows/lib/explain-design.test.mjs
// `isValidDesignShape` answers yes/no, which is all the workflow gate needs. A human working
// inline needs the other half: WHICH checkpoint is missing, one at a time, so a design can be
// brought up to the same bar incrementally instead of being re-submitted blind.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { explainDesignShape } from './explain-design.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { isValidDesignShape } from './design-schema.mjs'

const complete = {
  completionCriteria: ['users can export a canvas'],
  scope: 'apps/web/src/pages/Export.tsx',
  testScenarios: { unit: ['export returns a PNG'] },
  properties: ['none: pure UI wiring'],
  blastRadius: ['none: new leaf module'],
  userReach: ['rendered by CanvasPage, reachable from /w/:ws'],
}

test('a complete design explains nothing', () => {
  assert.deepEqual(explainDesignShape(complete), [])
})

test('each missing checkpoint is reported separately, naming the field', () => {
  const { blastRadius, userReach, ...partial } = complete
  const problems = explainDesignShape(partial)
  assert.equal(problems.length, 2)
  assert.ok(problems.some((p) => p.includes('blastRadius')))
  assert.ok(problems.some((p) => p.includes('userReach')))
})

test('a problem says what to supply, not just what is wrong', () => {
  const { userReach, ...partial } = complete
  assert.match(explainDesignShape(partial)[0], /foundation:/)
})

test('a blank entry is reported as its own problem, distinct from a missing field', () => {
  const blank = explainDesignShape({ ...complete, blastRadius: ['   '] })
  const missing = explainDesignShape({ ...complete, blastRadius: undefined })
  assert.equal(blank.length, 1)
  assert.equal(missing.length, 1)
  assert.notEqual(blank[0], missing[0])
})

test('a non-object is one problem, not a crash', () => {
  for (const bad of [null, undefined, 'nope', []]) {
    assert.equal(explainDesignShape(bad).length, 1)
  }
})

// One source of truth: the gate's boolean is derived from the explanation, so a checkpoint can
// never be enforced by one and ignored by the other.
test('isValidDesignShape agrees with explainDesignShape on every fixture', () => {
  for (const d of [complete, {}, null, { ...complete, userReach: [] }, { ...complete, scope: 42 }]) {
    assert.equal(isValidDesignShape(d), explainDesignShape(d).length === 0, JSON.stringify(d))
  }
})

// --- execution-mode handback ---
import { shouldHandBackForLiveVerification } from './explain-design.mjs'

// The observed failure: dev-loop implemented a UI change, then reported "manual browser
// verification was not performed — no browser-automation MCP tool was available in this
// subagent's toolset". The developer agent's tools are Read/Edit/Write/Bash/Glob/Grep; it
// structurally cannot do AGENTS.md step 3. Learning that AFTER implementing costs the whole run.
test('a design needing live verification hands back before implementing', () => {
  const r = shouldHandBackForLiveVerification({ manualVerification: 'drag a node and watch the edge re-route', dogfood: false })
  assert.equal(r.handBack, true)
  assert.match(r.recommendation, /main session/i)
})

test('the none: sentinel does not hand back', () => {
  assert.equal(shouldHandBackForLiveVerification({ manualVerification: 'none: pure server-side helper', dogfood: false }).handBack, false)
})

// Absent means the design never answered, which must preserve the existing behaviour rather than
// stopping every run that predates the field.
test('an absent answer does not hand back', () => {
  for (const v of [undefined, null, '', '   ']) {
    assert.equal(shouldHandBackForLiveVerification({ manualVerification: v, dogfood: false }).handBack, false)
  }
})

// dogfood:true means the caller already arranged a browser lane against a running app, so the
// verification the design asks for has somewhere to happen inside the run.
test('an explicit dogfood lane suppresses the handback', () => {
  assert.equal(shouldHandBackForLiveVerification({ manualVerification: 'click the toolbar button', dogfood: true }).handBack, false)
})

// The workflow keeps a mirrored inline copy (no module resolution in the sandbox); this is what
// keeps the two honest, and it also pins that the handback happens BEFORE Implement — a handback
// after implementing would defeat its whole purpose.
test('inline shouldHandBackForLiveVerification in dev-loop matches this module, and gates Implement', () => {
  const source = readFileSync(path.join(__dirname, '..', 'dev-loop.workflow.mjs'), 'utf8')
  const match = source.match(/\nfunction shouldHandBackForLiveVerification\(\{[\s\S]*?\n\}\n/)
  assert.ok(match, 'could not locate the inline shouldHandBackForLiveVerification')
  // eslint-disable-next-line no-new-func -- evaluating our own source
  const inline = new Function(`${match[0]}\nreturn shouldHandBackForLiveVerification`)()
  for (const input of [
    { manualVerification: 'drag a node', dogfood: false },
    { manualVerification: 'none: pure helper', dogfood: false },
    { manualVerification: 'drag a node', dogfood: true },
    { manualVerification: undefined, dogfood: false },
  ]) {
    assert.deepEqual(inline(input), shouldHandBackForLiveVerification(input), JSON.stringify(input))
  }
  assert.ok(
    source.indexOf('if (liveVerification.handBack)') < source.indexOf('// --- Phase 3: implement'),
    'the handback must be evaluated before the Implement phase',
  )
})
