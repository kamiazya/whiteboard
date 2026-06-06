const PRIVATE_ADDRESS_ERROR =
  'Private or local addresses are not allowed in external URLs.'

function invalidUrl(message: string): Error {
  const error = new Error(message)
  error.name = 'ExternalUrlPolicyError'
  return error
}

function normalizeHostname(hostname: string): string {
  const lowered = hostname.toLowerCase()
  if (lowered.startsWith('[') && lowered.endsWith(']')) {
    return lowered.slice(1, -1)
  }
  return lowered
}

function parseIpv4(hostname: string): number[] | null {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null
  const octets = hostname.split('.').map((part) => Number.parseInt(part, 10))
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null
  }
  return octets
}

function isPrivateOrLocalIpv4(octets: number[]): boolean {
  const [a, b] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isPrivateOrLocalIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true
  }
  if (normalized.startsWith('ff')) return true
  if (normalized.startsWith('2001:db8')) return true
  if (normalized.startsWith('::ffff:')) {
    const suffix = normalized.slice('::ffff:'.length)
    // Dotted-decimal form (e.g. ::ffff:192.168.1.1)
    const dotted = parseIpv4(suffix)
    if (dotted !== null) return isPrivateOrLocalIpv4(dotted)
    // Hex form produced by the WHATWG URL parser (e.g. ::ffff:c0a8:101)
    const hexParts = suffix.split(':')
    if (hexParts.length === 2) {
      const hi = Number.parseInt(hexParts[0], 16)
      const lo = Number.parseInt(hexParts[1], 16)
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
        return isPrivateOrLocalIpv4(octets)
      }
    }
  }
  return false
}

function isPrivateOrLocalLiteralIp(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  const ipv4 = parseIpv4(normalized)
  if (ipv4 !== null) return isPrivateOrLocalIpv4(ipv4)
  if (normalized.includes(':')) return isPrivateOrLocalIpv6(normalized)
  return false
}

export function validateBrowserExternalUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw invalidUrl(`Invalid external URL: "${rawUrl}"`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidUrl('External URL must use http or https.')
  }
  if (url.username || url.password) {
    throw invalidUrl('External URL credentials are not allowed.')
  }

  const hostname = normalizeHostname(url.hostname)
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw invalidUrl(PRIVATE_ADDRESS_ERROR)
  }

  if (isPrivateOrLocalLiteralIp(hostname)) {
    throw invalidUrl(PRIVATE_ADDRESS_ERROR)
  }

  return url
}

export function isExternalUrlPolicyError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'ExternalUrlPolicyError'
}
