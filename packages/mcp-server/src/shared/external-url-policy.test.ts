import { describe, expect, it } from 'vitest'
import { isExternalUrlPolicyError, validateBrowserExternalUrl } from './external-url-policy.js'

// Helper: assert that a URL string throws an ExternalUrlPolicyError
function expectRejected(rawUrl: string) {
  let caught: unknown
  try {
    validateBrowserExternalUrl(rawUrl)
  } catch (e) {
    caught = e
  }
  expect(caught, `expected "${rawUrl}" to be rejected`).toBeDefined()
  expect(isExternalUrlPolicyError(caught), `expected ExternalUrlPolicyError for "${rawUrl}"`).toBe(
    true,
  )
}

// Helper: assert that a URL string is accepted and returns a URL object
function expectAccepted(rawUrl: string) {
  const result = validateBrowserExternalUrl(rawUrl)
  expect(result).toBeInstanceOf(URL)
  expect(result.href).toBeTruthy()
}

describe('validateBrowserExternalUrl', () => {
  describe('protocol enforcement', () => {
    it('rejects non-http/https protocols', () => {
      expectRejected('ftp://example.com/file')
      expectRejected('file:///etc/passwd')
      expectRejected('javascript:alert(1)')
      expectRejected('data:text/plain,hello')
    })

    it('rejects malformed URLs', () => {
      expectRejected('not-a-url')
      expectRejected('')
      expectRejected('://missing-scheme')
    })

    it('rejects URLs with embedded credentials', () => {
      expectRejected('https://user:pass@example.com/')
      expectRejected('https://user@example.com/')
    })
  })

  describe('localhost and .local hostnames', () => {
    it('rejects localhost', () => {
      expectRejected('http://localhost/')
      expectRejected('http://localhost:3000/path')
      expectRejected('https://localhost/api')
    })

    it('rejects subdomains of localhost', () => {
      expectRejected('http://app.localhost/')
      expectRejected('https://api.app.localhost:8080/')
    })

    it('rejects .local mDNS names', () => {
      expectRejected('http://mydevice.local/')
      expectRejected('https://printer.local/config')
    })
  })

  describe('IPv4 loopback and private ranges', () => {
    it('rejects 127.0.0.1 (IPv4 loopback)', () => {
      expectRejected('http://127.0.0.1/')
      expectRejected('https://127.0.0.1:8080/path')
    })

    it('rejects full 127.0.0.0/8 loopback range', () => {
      expectRejected('http://127.0.0.2/')
      expectRejected('http://127.255.255.255/')
    })

    it('rejects 10.0.0.0/8 private range', () => {
      expectRejected('http://10.0.0.1/')
      expectRejected('http://10.255.255.255/')
      expectRejected('https://10.10.10.10/api')
    })

    it('rejects 172.16.0.0/12 private range', () => {
      expectRejected('http://172.16.0.1/')
      expectRejected('http://172.31.255.255/')
      expectRejected('https://172.20.0.5/')
    })

    it('rejects 192.168.0.0/16 private range', () => {
      expectRejected('http://192.168.0.1/')
      expectRejected('http://192.168.255.254/')
      expectRejected('https://192.168.1.100/')
    })

    it('rejects 169.254.0.0/16 link-local (APIPA)', () => {
      expectRejected('http://169.254.1.1/')
      expectRejected('http://169.254.169.254/')
    })

    it('rejects 0.0.0.0 (unspecified)', () => {
      expectRejected('http://0.0.0.0/')
    })

    it('rejects 100.64.0.0/10 shared address space', () => {
      expectRejected('http://100.64.0.1/')
      expectRejected('http://100.127.255.255/')
    })

    it('rejects multicast and reserved ranges (224+)', () => {
      expectRejected('http://224.0.0.1/')
      expectRejected('http://255.255.255.255/')
    })
  })

  describe('IPv6 private/local ranges', () => {
    it('rejects ::1 (IPv6 loopback)', () => {
      expectRejected('http://[::1]/')
      expectRejected('https://[::1]:8080/')
    })

    it('rejects :: (IPv6 unspecified)', () => {
      expectRejected('http://[::]/')
    })

    it('rejects fe80::/10 link-local addresses via range guard', () => {
      expectRejected('http://[fe80::1]/')
      expectRejected('http://[fe9f::1]/')
      expectRejected('http://[fea0::1]/')
      expectRejected('http://[feb0::1]/')
    })

    it('rejects zone-scoped link-local addresses at parse time (WHATWG URL rejects zone-ID syntax)', () => {
      // `new URL('http://[fe80::1%25eth0]/')` throws Invalid URL in the WHATWG
      // parser before the range guard is reached. The rejection is correct but
      // comes from parse failure, not from the fe80::/10 range check.
      expectRejected('http://[fe80::1%25eth0]/')
    })

    it('rejects fc00::/7 ULA (fc and fd prefixes)', () => {
      expectRejected('http://[fc00::1]/')
      expectRejected('http://[fd00::1]/')
      expectRejected('http://[fd12:3456:789a::1]/')
    })

    it('rejects ff00::/8 multicast', () => {
      expectRejected('http://[ff02::1]/')
      expectRejected('http://[ffff::1]/')
    })

    it('rejects 2001:db8::/32 documentation range', () => {
      expectRejected('http://[2001:db8::1]/')
      expectRejected('http://[2001:db8:dead:beef::1]/')
    })

    it('rejects IPv4-mapped IPv6 addresses with private IPv4 (::ffff:192.168.x.x)', () => {
      // The WHATWG URL parser normalises dotted-decimal input (e.g. ::ffff:192.168.1.1)
      // to two hex 16-bit groups (::ffff:c0a8:101) in url.hostname before the
      // policy check runs, so the hex-group path is the only reachable path.
      expectRejected('http://[::ffff:192.168.1.1]/')
      expectRejected('http://[::ffff:10.0.0.1]/')
      expectRejected('http://[::ffff:172.16.0.1]/')
      expectRejected('http://[::ffff:127.0.0.1]/')
    })

    it('WHATWG URL normalises IPv4-mapped addresses to hex-group form', () => {
      // Regression guard for the parseMappedIpv4 assumption: dotted input is
      // never seen by the policy function because the parser normalises it first.
      const dotted = new URL('http://[::ffff:192.168.1.1]/')
      expect(dotted.hostname).toBe('[::ffff:c0a8:101]')
      const public_ = new URL('http://[::ffff:8.8.8.8]/')
      expect(public_.hostname).toBe('[::ffff:808:808]')
    })
  })

  describe('valid public URLs accepted', () => {
    it('accepts public IPv4 addresses', () => {
      expectAccepted('http://8.8.8.8/')
      expectAccepted('https://1.1.1.1/')
      expectAccepted('http://8.8.4.4/')
    })

    it('accepts public domain names', () => {
      expectAccepted('https://example.com/')
      expectAccepted('https://www.example.org/path?q=1')
      expectAccepted('http://api.github.com/repos')
    })

    it('accepts public IPv6 addresses', () => {
      expectAccepted('http://[2001:4860:4860::8888]/')
      expectAccepted('https://[2606:4700:4700::1111]/')
    })

    it('accepts IPv4-mapped IPv6 with public IPv4', () => {
      expectAccepted('http://[::ffff:8.8.8.8]/')
    })

    it('accepts URLs with ports and paths', () => {
      expectAccepted('https://example.com:443/path/to/resource')
      expectAccepted('http://example.com:8080/api?key=value#anchor')
    })
  })
})
