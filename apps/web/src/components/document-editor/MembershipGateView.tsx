import { PASSKEY_NEEDED_COPY } from '../../lib/membership-refusal.js'
import { Button } from '../ui/button.js'

/**
 * The full-page render of `daemon-page-state.ts`'s `membership-refused`
 * kind for a `requires_person_session` refusal (ADR-0041/0042 S8 slice 3):
 * the session simply has not bound its passkey yet, so the page asks once
 * rather than showing an error. A `not_a_member` refusal is a different
 * page entirely — S5's removed surface (`ReplicaReadPage` with `withheld`)
 * — because it is a stated ban, not a retryable condition.
 *
 * This view carries no `role="status"` of its own: it is only ever mounted
 * once the loading skeleton it replaces unmounts, so a status region born
 * here would arrive already carrying its message (polite-live-region.test.ts)
 * — DaemonDocumentPage's persistent status paragraph announces it instead.
 */
export function MembershipGateView({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{PASSKEY_NEEDED_COPY.body}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {PASSKEY_NEEDED_COPY.action}
      </Button>
    </div>
  )
}
