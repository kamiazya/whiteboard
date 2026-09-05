// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decideConnectGate, explainProbeFailure } from './local-network-gate.js'

describe('decideConnectGate', () => {
  it('probes straight away from a loopback page, whatever the permission says', () => {
    // A loopback page reaches the daemon same-origin, so Local Network Access
    // never applies. Explaining a permission that cannot gate this request
    // would be a modal in front of nothing.
    for (const permission of ['granted', 'prompt', 'denied', 'unknown'] as const) {
      expect(decideConnectGate({ pageOriginScheme: 'http', permission })).toBe('probe')
    }
  })

  it('explains itself before a prompt the user has not answered yet', () => {
    // The prompt fires on the request itself, so without this the browser asks
    // about "local network access" with no stated reason. A denial is sticky,
    // making that unexplained prompt a one-shot the user usually loses.
    expect(decideConnectGate({ pageOriginScheme: 'https', permission: 'prompt' })).toBe('explain')
  })

  it('does not probe once the permission is denied', () => {
    // The request cannot succeed and re-asking does not re-prompt, so probing
    // only produces a failure that looks like an absent daemon.
    expect(decideConnectGate({ pageOriginScheme: 'https', permission: 'denied' })).toBe('blocked')
  })

  it('stays out of the way once the permission is granted', () => {
    expect(decideConnectGate({ pageOriginScheme: 'https', permission: 'granted' })).toBe('probe')
  })

  it('probes when the permission could not be read', () => {
    // 'unknown' means the engine does not know the feature, which in practice
    // means it never prompts (Safari, Firefox). Showing a Chrome-shaped
    // explanation there would describe a dialog that never appears.
    expect(decideConnectGate({ pageOriginScheme: 'https', permission: 'unknown' })).toBe('probe')
  })
})

describe('explainProbeFailure', () => {
  it('rules the browser out when the permission is granted', () => {
    // The case the probe could never call before. Note what it stops short
    // of: a daemon that has not allowlisted this origin fails exactly like an
    // empty port, so 'unreachable' claims only that the browser let the
    // request through.
    expect(
      explainProbeFailure({
        pageOriginScheme: 'https',
        permission: 'granted',
        reason: 'network',
      }),
    ).toBe('unreachable')
  })

  it('blames the browser when the permission is denied', () => {
    expect(
      explainProbeFailure({ pageOriginScheme: 'https', permission: 'denied', reason: 'network' }),
    ).toBe('browser-blocked')
  })

  it('reports an unanswered prompt as its own outcome', () => {
    // Dismissing the prompt is neither a missing daemon nor a standing
    // denial: asking again still works, which no other outcome implies.
    expect(
      explainProbeFailure({ pageOriginScheme: 'https', permission: 'prompt', reason: 'network' }),
    ).toBe('permission-unanswered')
  })

  it('rules the browser out on a loopback page even when the permission is unread', () => {
    // Same-scheme loopback cannot be blocked by the browser, so the answer
    // does not depend on a permission this page never needed.
    expect(
      explainProbeFailure({ pageOriginScheme: 'http', permission: 'unknown', reason: 'refused' }),
    ).toBe('unreachable')
  })

  it('keeps a proven browser block over whatever the permission says', () => {
    // WebKit's mixed-content rejection is measured, not inferred, and WebKit
    // reports no local-network permission at all — trusting 'unknown' here
    // would discard the one engine-confirmed block we can detect.
    expect(
      explainProbeFailure({ pageOriginScheme: 'https', permission: 'unknown', reason: 'blocked' }),
    ).toBe('browser-blocked')
  })

  it('separates something answering badly from nothing answering', () => {
    // An HTTP error or unparseable body means a server IS on that port and it
    // is not the daemon — telling the user to start a daemon there would send
    // them to fix the wrong thing.
    for (const reason of ['http-error', 'malformed'] as const) {
      expect(
        explainProbeFailure({ pageOriginScheme: 'https', permission: 'granted', reason }),
      ).toBe('not-a-daemon')
    }
  })

  it('admits it cannot tell when the permission is unreadable', () => {
    expect(
      explainProbeFailure({ pageOriginScheme: 'https', permission: 'unknown', reason: 'network' }),
    ).toBe('unclear')
  })
})
