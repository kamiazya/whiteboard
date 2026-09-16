/**
 * A resize that may never settle, made to say why — the decision half of
 * `setViewport`.
 *
 * Its own module because `viewport.ts` imports `vitest/browser`, which throws
 * outside browser mode, while the rule this states is checkable with no browser
 * at all: a window that refuses a resize is a state no test can ask for, so the
 * refusal is injected and the decision runs in jsdom.
 *
 * `viewport.ts` carries the account of WHY a resize can hang, what the CDP
 * refusal is, and the two hypotheses the retry below distinguishes. Read it
 * before changing anything here; this file is only the shape of the answer.
 */

/**
 * A ceiling sized on a measurement, not a delay. `page.viewport` reads 5-8ms
 * over six consecutive calls on an idle machine; the browser projects' own
 * worst case under a full parallel run is ~26x its isolated cost
 * (`integrator-flow.md`'s 1.5s -> 39s), which puts a loaded resize near 200ms.
 * 5s is ~600x the idle reading and ~25x the loaded estimate — ample for a slow
 * machine, and 12x faster than the 60s per-test budget it replaces.
 */
const RESIZE_BUDGET_MS = 5_000

/**
 * Whether `work` settled inside the budget.
 *
 * `Promise.race` subscribes to every entry it is handed, so the rejection that
 * arrives after the race has already settled is DELIVERED and discarded rather
 * than left unhandled — which matters here because a refused
 * `setWindowBounds` rejects long after this gave up, and an unhandled
 * rejection belonging to no test is the second mystery `viewport.ts`
 * describes. That is worth stating because the subscription is the load-bearing
 * part and it does not look like it: an explicit `work.catch(() => {})` stood
 * here first, and removing it changed nothing measurable. Its test survives
 * that removal and fails against a wait that does not subscribe, which is what
 * says where the property actually lives.
 */
async function settlesWithin(work: Promise<unknown>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs)
  })
  try {
    return await Promise.race([work.then(() => true), expiry])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The decision with its two effects injected, so it can be driven without a
 * window that actually refuses. `viewport-resize.test.ts` drives it in jsdom;
 * `setViewport` is the composition that names the real effects.
 */
export async function resizeOrExplain(
  resize: () => Promise<unknown>,
  clearBlockers: () => Promise<void>,
  describeRequest: string,
  budgetMs: number = RESIZE_BUDGET_MS,
): Promise<void> {
  await clearBlockers()
  if (await settlesWithin(resize(), budgetMs)) return

  // The retry IS the experiment; see hypothesis 2 in the header.
  await clearBlockers()
  if (await settlesWithin(resize(), budgetMs)) return

  throw new Error(
    `${describeRequest} did not settle within ${budgetMs}ms, twice. ` +
      'CDP Browser.setWindowBounds refuses a minimized, maximized or fullscreen window, and ' +
      'vitest never delivers that rejection — so this is thrown here rather than left to time ' +
      'the test out. Twice means the blocking state OUTLASTED a retry, so it is not another ' +
      "iframe's momentary fullscreen (which this helper exits, at the top document, before each " +
      'attempt). Suspect a window state no page-side API can clear — see the hypotheses on ' +
      'setViewport. The test that reports this is the victim, not the cause.',
  )
}
