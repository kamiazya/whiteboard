import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { settingsPath } from '../../lib/app-routes.js'
import { formatBytes } from '../../lib/format-bytes.js'
import type { InstallState } from '../../lib/install-prompt-store.js'
import type { BrowserStorageEstimate } from '../../lib/persistent-storage.js'

export type PersistStepState = 'unknown' | 'granted' | 'browser-managed' | 'todo'

export interface SetupJourneyProps {
  persist: PersistStepState
  /**
   * True after a Protect request came back without a grant. Chromium
   * decides silently on engagement heuristics, so "nothing happened" is a
   * real outcome the user must be told about — otherwise the button reads
   * as broken.
   */
  protectDeclined?: boolean
  /** A Protect request is in flight. */
  protecting: boolean
  onProtect: () => void
  install: InstallState['status']
  onInstall: () => void
  daemonConnected: boolean
  /**
   * Each step carries its own measured evidence (no separate storage
   * report surface — the journey is the one place). null/undefined = no
   * figure available; the step renders without one.
   */
  estimate?: BrowserStorageEstimate | null
  /** Total bytes the connected companion app keeps; null/undefined = unknown. */
  daemonStorageBytes?: number | null
}

type StepKind = 'done' | 'action' | 'blocked'

interface Step {
  key: string
  kind: StepKind
  title: string
  state: string
  desc?: string
  /** Measured evidence for this step (usage figures), shown under the desc. */
  detail?: ReactNode
  action?: ReactNode
  hint?: string
}

const ACTION_CLASS =
  'mt-1.5 inline-block rounded-md border border-primary px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/5'

/**
 * The durability ladder: each step is a detectable state of how safe the
 * user's data is, from "in one browser profile" up to "owned by a local
 * daemon". Steps the current environment cannot advance render dashed
 * (blocked) rather than as dead action buttons.
 */
export function SetupJourney({
  persist,
  protectDeclined = false,
  protecting,
  onProtect,
  install,
  onInstall,
  daemonConnected,
  estimate,
  daemonStorageBytes,
}: SetupJourneyProps) {
  const usageDetail =
    estimate == null
      ? undefined
      : `${formatBytes(estimate.usageBytes)} used · ${formatBytes(estimate.quotaBytes)} available`
  const steps: Step[] = [
    {
      key: 'draw',
      kind: 'done',
      title: 'Draw in your browser',
      state: "you're here",
      desc: 'Canvases live in this browser profile, no account needed.',
    },
    persist === 'granted' || persist === 'browser-managed'
      ? {
          key: 'protect',
          kind: 'done',
          title: 'Protect your data',
          state: persist === 'granted' ? 'granted' : 'managed by the browser',
          detail: usageDetail,
        }
      : {
          key: 'protect',
          kind: 'action',
          title: 'Protect your data',
          state: persist === 'unknown' ? '…' : 'not granted yet',
          detail: usageDetail,
          desc: 'Ask the browser to keep your documents even when it is running low on space — without this it may delete them to free up room.',
          action:
            persist === 'todo' ? (
              <button
                type="button"
                className={ACTION_CLASS}
                disabled={protecting}
                onClick={onProtect}
              >
                {protecting ? 'Protecting…' : 'Protect'}
              </button>
            ) : undefined,
          hint: protectDeclined
            ? 'Your browser turned this down for now — it usually grants it once you have used the app a few times. Your documents still work; keep an export of anything you cannot lose.'
            : undefined,
        },
    install === 'installed'
      ? { key: 'install', kind: 'done', title: 'Install the app', state: 'installed' }
      : install === 'installable'
        ? {
            key: 'install',
            kind: 'action',
            title: 'Install the app',
            state: 'installable',
            desc: 'Give the whiteboard its own window, icon, and offline start.',
            action: (
              <button type="button" className={ACTION_CLASS} onClick={onInstall}>
                Install
              </button>
            ),
          }
        : {
            key: 'install',
            kind: 'blocked',
            title: 'Install the app',
            state: 'no prompt available',
            hint: 'Your browser’s menu may offer Install or Add to Home Screen.',
          },
    daemonConnected
      ? {
          key: 'daemon',
          kind: 'done',
          title: 'Connect the companion app',
          state: 'connected',
          detail:
            daemonStorageBytes == null ? undefined : (
              <>
                {`${formatBytes(daemonStorageBytes)} on this computer · `}
                <Link to={settingsPath('connections')} className="underline">
                  breakdown
                </Link>
              </>
            ),
        }
      : {
          key: 'daemon',
          kind: 'action',
          title: 'Connect the companion app',
          state: 'not connected',
          desc: 'Run the companion app to keep documents in real files on your computer, with version history.',
          action: (
            <Link to={settingsPath('connections')} className={ACTION_CLASS}>
              How to connect
            </Link>
          ),
        },
  ]

  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => (
        <li key={step.key} className="relative flex gap-3 pb-5 last:pb-0">
          {index < steps.length - 1 && (
            <span
              aria-hidden="true"
              className={`absolute bottom-0 left-[13px] top-8 w-px ${
                step.kind === 'done' ? 'bg-green-600/40' : 'bg-border'
              }`}
            />
          )}
          <span
            data-journey-badge={step.key}
            className={`z-10 flex size-7 shrink-0 items-center justify-center rounded-full border-2 bg-background text-xs font-semibold ${
              step.kind === 'done'
                ? 'border-green-600 text-green-600 dark:border-green-500 dark:text-green-500'
                : step.kind === 'action'
                  ? 'border-primary text-primary'
                  : 'border-dashed border-border text-muted-foreground'
            }`}
          >
            {step.kind === 'done' ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
          </span>
          <div className="min-w-0 flex-1 pt-1">
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
              {step.title}
              <span
                className={`font-mono text-[11px] font-normal ${
                  step.kind === 'done'
                    ? 'text-green-600 dark:text-green-500'
                    : 'text-muted-foreground'
                }`}
              >
                {step.state}
              </span>
            </p>
            {step.desc !== undefined && (
              <p className="mt-0.5 text-xs text-muted-foreground">{step.desc}</p>
            )}
            {step.detail !== undefined && (
              <p
                data-journey-detail={step.key}
                className="mt-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {step.detail}
              </p>
            )}
            {step.action}
            {step.hint !== undefined && (
              <p className="mt-1 text-xs italic text-muted-foreground">{step.hint}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

/**
 * The confetti origin for a completed step. The settings page renders the
 * journey twice (hidden mobile + desktop structures), so pick whichever badge
 * is actually laid out — `offsetParent` is null inside a `display: none`
 * subtree.
 */
export function findVisibleJourneyBadge(step: 'protect' | 'install'): HTMLElement | undefined {
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(`[data-journey-badge="${step}"]`),
  )) {
    if (el.offsetParent !== null) return el
  }
  return undefined
}
