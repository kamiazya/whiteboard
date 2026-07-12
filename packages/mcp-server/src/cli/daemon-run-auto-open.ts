// Opens the user's default browser at the daemon's own origin once
// `whiteboard daemon run` is listening. Since ADR 0001 R3, the daemon serves
// the same apps/web build at its own origin and injects the daemon token
// server-side into the HTML it returns, so this origin needs no pairing
// link and no token ever appears in a URL.
//
// All environment reads (TTY, env vars, container probe, the `open` call
// itself) are injected so every guard combination is a plain unit test with
// no real terminal, filesystem, or subprocess involved.

import open from 'open'
import { decideAutoOpenBrowser } from '../daemon/browser-open-policy.js'
import {
  defaultContainerDetectionDeps,
  isRunningInContainer,
} from '../daemon/container-detection.js'
import { getLogger } from '../server/log.js'

const log = getLogger('daemon-run-auto-open')

export interface MaybeOpenDaemonBrowserInput {
  host: string
  port: number
  /** Resolved --no-open flag. */
  noOpenFlag: boolean
  /** Resolved config-file `openBrowser` key, if any. */
  configOpenBrowser: boolean | undefined
  isTTY?: boolean
  env?: Readonly<Record<string, string | undefined>>
  isContainerFn?: () => boolean
  openFn?: (url: string) => Promise<unknown>
}

// --no-open and a config-file `openBrowser: false` both force the feature
// off regardless of the other input; only the absence of both falls
// through to the default-on behavior described in the CLI usage and docs.
function resolveOpenOption(noOpenFlag: boolean, configOpenBrowser: boolean | undefined): boolean {
  if (noOpenFlag) return false
  return configOpenBrowser ?? true
}

export async function maybeOpenDaemonBrowser(input: MaybeOpenDaemonBrowserInput): Promise<void> {
  // The daemon has already started successfully and emitted its ready JSON
  // by the time this runs — everything below is a best-effort UX nicety on
  // top of that success. A throw ANYWHERE in this function (the policy
  // decision, the container probe, or the actual open() call) must never
  // propagate: the caller does not — and must not have to — wrap this call
  // in its own try/catch. The URL is computed up front so every failure
  // path below can tell the user what to open manually.
  const url = `http://${input.host}:${input.port}`
  try {
    const env = input.env ?? process.env
    const decision = decideAutoOpenBrowser({
      host: input.host,
      isTTY: input.isTTY ?? Boolean(process.stdout.isTTY),
      isContainer: (
        input.isContainerFn ?? (() => isRunningInContainer(env, defaultContainerDetectionDeps))
      )(),
      env,
      openOption: resolveOpenOption(input.noOpenFlag, input.configOpenBrowser),
    })

    if (!decision.shouldOpen) {
      log.debug({ reason: decision.reason }, 'skipped auto-opening the browser')
      return
    }

    await (input.openFn ?? open)(url)
    log.info({ url }, 'opened the default browser at the daemon origin')
  } catch (err) {
    // A failed browser launch (no display, sandboxed environment, missing
    // `xdg-open`, a bug in the policy/container-detection code, …) must
    // never take the daemon down with it. Logging the URL here is the
    // actionable part: it's the one thing that leaves the human with a
    // path forward (open it themselves) instead of a dead end.
    log.warning({ url, err }, 'failed to auto-open the default browser — open it manually')
  }
}
