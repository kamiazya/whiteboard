import { describe, expect, it } from 'vitest'
import type { ApprovalView } from '../security/oauth-authz-transactions.js'
import { renderApprovalPage, renderAuthorizeErrorPage } from './oauth-approval-page.js'

function baseView(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    clientId: 'demo-client',
    redirectUri: 'https://app.example.test/callback?next=/dashboard',
    scopes: ['canvas:read', 'workspace:write'],
    status: 'pending',
    expiresAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('renderApprovalPage', () => {
  it('derives the relying-party identity from the registered redirect URI origin only', () => {
    const html = renderApprovalPage({
      transactionId: 'txn-1',
      csrfToken: 'csrf-1',
      view: baseView({
        redirectUri: 'https://app.example.test/callback?evil=https://attacker.test',
      }),
    })

    expect(html).toContain('https://app.example.test')
    expect(html).not.toContain('attacker.test')
  })

  it('HTML-escapes every interpolated value', () => {
    const html = renderApprovalPage({
      transactionId: '"><script>alert(1)</script>',
      csrfToken: 'csrf-1',
      view: baseView({ clientId: '<b>evil</b>' }),
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<b>evil</b>')
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;')
  })

  it('emits no <script> tag and no inline event handler, per CSP script-src none', () => {
    const html = renderApprovalPage({
      transactionId: 'txn-1',
      csrfToken: 'csrf-1',
      view: baseView(),
    })

    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/\son\w+\s*=/i)
  })

  it('lists every requested scope with human-readable copy', () => {
    const html = renderApprovalPage({
      transactionId: 'txn-1',
      csrfToken: 'csrf-1',
      view: baseView({ scopes: ['canvas:read', 'files:write'] }),
    })

    expect(html).toContain('Read canvas content')
    expect(html).toContain('Write files')
  })

  it('renders Deny before Approve and autofocused, with nothing pre-checked', () => {
    const html = renderApprovalPage({
      transactionId: 'txn-1',
      csrfToken: 'csrf-1',
      view: baseView(),
    })

    const denyIndex = html.indexOf('value="deny"')
    const approveIndex = html.indexOf('value="approve"')
    expect(denyIndex).toBeGreaterThan(-1)
    expect(approveIndex).toBeGreaterThan(-1)
    expect(denyIndex).toBeLessThan(approveIndex)
    expect(html).toMatch(/name="decision" value="deny"[^>]*autofocus/)
    expect(html).not.toContain('checked')
  })

  it('carries the transaction id and CSRF token as hidden form fields', () => {
    const html = renderApprovalPage({
      transactionId: 'txn-42',
      csrfToken: 'csrf-secret',
      view: baseView(),
    })

    expect(html).toContain('name="transaction_id" value="txn-42"')
    expect(html).toContain('name="csrf_token" value="csrf-secret"')
  })
})

describe('renderAuthorizeErrorPage', () => {
  it('renders a local error page without any redirect affordance', () => {
    const html = renderAuthorizeErrorPage('unknown_client')

    expect(html).not.toMatch(/<meta[^>]+refresh/i)
    expect(html).not.toMatch(/<script/i)
    expect(html.toLowerCase()).toContain('not registered')
  })

  it('renders a distinct message for a restarted daemon', () => {
    const html = renderAuthorizeErrorPage('transaction_not_found')

    expect(html.toLowerCase()).toContain('restart')
  })

  it('renders a distinct message for a rate-limited client', () => {
    const html = renderAuthorizeErrorPage('rate_limited')

    expect(html.toLowerCase()).toContain('too many')
  })
})
