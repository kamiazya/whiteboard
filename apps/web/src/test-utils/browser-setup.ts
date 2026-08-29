/**
 * Loads the app's real stylesheet into every browser test.
 *
 * Without it, Tailwind utility classes silently do nothing: a `className` of
 * `absolute bottom-3 z-10` computes to `position: static`, so chrome that the
 * app pins to an edge instead lands in ordinary document flow. Elements
 * positioned by INLINE style — the canvas scene's nodes — are unaffected, so
 * an unstyled dock and a correctly-positioned scene can physically collide
 * and a button becomes unclickable. Playwright reports that as a click that
 * never lands rather than a failed assertion, which reads like a hang and
 * points nowhere near the cause.
 *
 * The running app always loads this stylesheet, so a test that renders
 * without it is testing a layout no user ever sees. Loading it here removes
 * the per-file decision entirely.
 */
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { configure } from '@testing-library/react'
import '../index.css'
import { BROWSER_DEFAULT_SEGMENT } from '../lib/browser-idb.js'
import { setBrowserWorkspaceIdForTests } from '../lib/browser-workspace-id.js'

/**
 * A browser test renders production code that reads `getBrowserWorkspaceId()`
 * at its ordinary call sites, but no test runs the boot chain that resolves
 * it — so without a seed here the accessor's unresolved-state throw reaches
 * any test whose fixture is purely in-memory (a `LocalStoreDouble`, say)
 * rather than an IndexedDB one, where `claimIsolatedWhiteboardDb` seeds it.
 * A fixed per-file id, minted once, is what those call sites see; the same
 * default the jsdom setup installs, for the same reason.
 *
 * A test exercising the accessor's own unresolved/failed states resets it
 * explicitly.
 */
setBrowserWorkspaceIdForTests(generateDocumentId(), BROWSER_DEFAULT_SEGMENT)

/**
 * Testing Library's `findBy*`/`waitFor` default is 1000ms, which is a
 * fast-machine number: under parallel browser files it is routinely too
 * short for a portal to mount or an IndexedDB round trip to land. Ten tests
 * had already worked around it with a local `{ timeout: 10_000 }`, which is
 * the smell of a global default set too low.
 *
 * Like the test timeout, this is a ceiling rather than a delay — raising it
 * slows nothing down that succeeds.
 */
configure({ asyncUtilTimeout: 5_000 })
