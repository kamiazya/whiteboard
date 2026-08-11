export const meta = {
  name: 'consult-adversarial',
  description:
    'Answer a hard technical question/decision, then adversarially refute it before trusting it: consult -> skeptical review -> skeptic panel refutes load-bearing claims -> accept iff nothing survives, else compose a focused follow-up and loop (bounded). Surfaces to the human if unresolved.',
  whenToUse:
    'When a wrong-but-plausible answer would be costly (architecture/data-model/security/LNA decisions). Not for implementing — feeds plan-initiative / dev-loop. Pass args:{question, cwd?, consultant?, verifyBudget?, maxRounds?, codex?}. consultant: agent|codex|panel.',
  // Adapted from mann1x/claude-hooks consult-with-adversarial-review (which drove an external
  // claude-consultants CLI council). Here the council is our own agents/Codex; the durable idea
  // is: refute load-bearing claims against the real repo before accepting the answer.
  phases: [
    { title: 'Consult', detail: 'produce an answer (agent / codex / expert panel)' },
    { title: 'Review', detail: 'skeptic triages wrong assumptions + load-bearing claims' },
    { title: 'Verify', detail: 'skeptic panel tries to REFUTE each claim against the repo' },
    { title: 'Decide', detail: 'accept, or compose a follow-up and loop' },
  ],
}

// --- inputs (runtime delivers args as a JSON string) ---
const A = (() => {
  if (typeof args !== 'string') return args && typeof args === 'object' ? args : {}
  // Malformed args is a caller bug with no sane default. Falling back to {} does not stop the
  // run — it completes against empty inputs and reports "nothing was specified" after spending
  // the whole agent budget, which reads as a finding rather than the input error it is.
  try {
    return JSON.parse(args)
  } catch (err) {
    throw new Error(`args is not valid JSON (${err.message}): ${args.slice(0, 200)}`)
  }
})()
const QUESTION = A.question || ''
const CWD = A.cwd || null
const CONSULTANT = ['agent', 'codex', 'panel'].includes(A.consultant) ? A.consultant : 'agent'
const BUDGET = A.verifyBudget || 'bounded'
const PANEL = ({ minimal: 2, bounded: 3, generous: 5 })[BUDGET] || 3
const MAX_ROUNDS = Number(A.maxRounds || 3)
const CODEX = A.codex !== false
const GIT = CWD ? `git -C ${CWD}` : 'git'
const cwdHint = CWD ? ` Read the repo under ${CWD} (run git as \`${GIT} ...\`).` : ' Read the repo to ground your reasoning.'

if (!QUESTION) {
  return { accepted: false, error: 'args.question is required' }
}

// --- schemas ---
const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { answer: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } } },
  required: ['answer'],
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { enum: ['accept', 'followup'] },
    concerns: { type: 'array', items: { type: 'string' } },
    claimsToVerify: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { claim: { type: 'string' }, where: { type: 'string' } }, required: ['claim'] },
    },
  },
  required: ['verdict', 'concerns', 'claimsToVerify'],
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { claim: { type: 'string' }, refuted: { type: 'boolean' }, why: { type: 'string' } },
  required: ['claim', 'refuted', 'why'],
}

// --- consultant (the "council"): produce an answer to a brief ---
async function consult(brief, round) {
  if (CONSULTANT === 'codex') {
    return agent(`${brief}\n\n${cwdHint} Give a concrete, grounded answer with assumptions made.`,
      { label: `consult:codex:${round}`, phase: 'Consult', agentType: 'codex:codex-rescue', schema: ANSWER_SCHEMA })
  }
  if (CONSULTANT === 'panel') {
    const roles = ['architect', 'security-architect', 'product-manager']
    const views = (await parallel(roles.map((r) => () =>
      agent(`${brief}\n\nGive your perspective's recommendation with rationale.${cwdHint}`,
        { label: `consult:${r}:${round}`, phase: 'Consult', agentType: r, schema: ANSWER_SCHEMA }))
    )).filter(Boolean)
    return agent(`Synthesize ONE answer to the question from these expert views. Brief: ${brief}\nViews: ${JSON.stringify(views.map((v) => v.answer))}`,
      { label: `consult:synth:${round}`, phase: 'Consult', agentType: 'architect', schema: ANSWER_SCHEMA })
  }
  return agent(`${brief}\n\n${cwdHint} Give a concrete, grounded answer with assumptions made.`,
    { label: `consult:${round}`, phase: 'Consult', schema: ANSWER_SCHEMA })
}

// Compose surviving refutations + concerns into a focused follow-up brief (plain JS).
function composeChallenge(review, survived, prevAnswer) {
  const lines = [`Re-answer the question, correcting the problems found in your previous answer.`, ``, `QUESTION: ${QUESTION}`, ``, `PREVIOUS ANSWER:`, prevAnswer, ``]
  if (survived.length) {
    lines.push('These load-bearing claims FAILED adversarial verification — correct or re-ground each:')
    for (const v of survived) lines.push(`- ${v.claim} — refuted because: ${v.why}`)
  }
  const concerns = (review.concerns || []).filter(Boolean)
  if (concerns.length) {
    lines.push('Also address these open concerns:')
    for (const c of concerns) lines.push(`- ${c}`)
  }
  if (!survived.length && !concerns.length) lines.push('Tighten any unsupported claim and cite path:line for each codebase-dependent statement.')
  return lines.join('\n')
}

// --- the loop ---
phase('Consult')
let answer = (await consult(`Answer this question for the whiteboard project.\n\nQUESTION: ${QUESTION}`, 0))
if (!answer || !answer.answer) return { accepted: false, error: 'consultant produced no answer' }
let current = answer.answer
let round = 0
const history = []

while (true) {
  round++

  const review = await agent(
    `You are a skeptical staff engineer reviewing an answer to a question. Do not rubber-stamp it.\n\nQUESTION: ${QUESTION}\n\nANSWER:\n${current}\n\n` +
      `Find (a) wrong assumptions about this project (a file/flag/API it claims that may not exist, or a claim contradicting how the repo works); (b) gaps; (c) load-bearing claims worth independent verification.${cwdHint} You MAY read to sanity-check, but TRIAGE here — the panel verifies. Return verdict accept if no material concern, else followup; list concerns and claimsToVerify (most load-bearing first; panel checks top ${PANEL}; include a where pointer when you can).`,
    { label: `review:${round}`, phase: 'Review', schema: REVIEW_SCHEMA },
  )

  // The review agent can return null (terminal API error / session limit). Don't crash the
  // workflow — surface for human review instead of dereferencing a null verdict.
  if (!review) {
    log(`round ${round}: review agent returned no result (likely an API/session limit) — surfacing for human`)
    return { accepted: false, rounds: round, answer: current, history, unresolved: { reason: 'review-agent-returned-null' }, needsHumanGate: true }
  }

  const claims = (review.claimsToVerify || []).slice(0, PANEL)
  const skeptics = claims.map((c, i) => () =>
    agent(
      `You are an adversarial verifier. Try to REFUTE this single claim made in answering: ${QUESTION}\n\nCLAIM: ${c.claim}\n${c.where ? `WHERE: ${c.where}\n` : ''}\n` +
        `${cwdHint} Hunt for how the claim is false or overstated — a missing file, a flag that doesn't exist, a path:line that doesn't say what it's cited for, a generalization false here. Set refuted:true ONLY with concrete evidence; if it checks out, refuted:false. "why" must cite what you looked at.`,
      { label: `skeptic:${round}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ),
  )
  // Optional Codex skeptic as an extra adversarial perspective.
  if (CODEX && claims.length) {
    const c0 = claims[0]
    skeptics.push(() =>
      agent(`Adversarially refute the most load-bearing claim in this answer if you can.\nQUESTION: ${QUESTION}\nCLAIM: ${c0.claim}\n${cwdHint} refuted:true only with concrete repo evidence.`,
        { label: `skeptic:${round}:codex`, phase: 'Verify', agentType: 'codex:codex-rescue', schema: VERDICT_SCHEMA }))
  }
  const verdicts = (await parallel(skeptics)).filter(Boolean)
  const survived = verdicts.filter((v) => v.refuted)
  history.push({ round, verdict: review.verdict, refuted: survived.length, checked: verdicts.length })
  log(`round ${round}: verdict=${review.verdict}, ${survived.length}/${verdicts.length} claims refuted`)

  // Accept iff reviewer satisfied AND nothing survived refutation.
  if (review.verdict === 'accept' && survived.length === 0) {
    phase('Decide')
    return { accepted: true, rounds: round, answer: current, history }
  }
  if (round >= MAX_ROUNDS) {
    log(`reached maxRounds=${MAX_ROUNDS} without acceptance — surfacing for human review (NOT auto-accepting)`)
    return { accepted: false, rounds: round, answer: current, history, unresolved: { concerns: review.concerns, refutations: survived }, needsHumanGate: true }
  }

  phase('Decide')
  const next = await consult(composeChallenge(review, survived, current), round)
  if (!next || !next.answer) {
    return { accepted: false, rounds: round, answer: current, history, error: 'follow-up consult produced no answer', needsHumanGate: true }
  }
  current = next.answer
}
