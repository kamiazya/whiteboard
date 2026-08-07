import { describe, expect, it, vi } from 'vitest'
import { candidateBaseUrls, discoverDaemons, rememberKnownDaemon } from './daemon-discovery.js'
import type { DaemonProbeResult, ProbeDaemonOptions } from './daemon-probe.js'

const DETECTED = (id: string): DaemonProbeResult => ({ detected: true, instanceId: id })
const MISS: DaemonProbeResult = { detected: false, reason: 'refused' }

function probeMap(map: Record<string, DaemonProbeResult>) {
  return vi.fn(
    async (baseUrl: string, _options: ProbeDaemonOptions): Promise<DaemonProbeResult> => {
      return map[baseUrl] ?? MISS
    },
  )
}

describe('candidateBaseUrls', () => {
  it('puts remembered daemons first, then the port range, deduplicated', () => {
    const candidates = candidateBaseUrls({
      remembered: ['http://127.0.0.1:3105', 'http://127.0.0.1:3099'],
      portRangeStart: 3099,
      portRangeCount: 3,
    })
    expect(candidates).toEqual([
      'http://127.0.0.1:3105',
      'http://127.0.0.1:3099',
      'http://127.0.0.1:3100',
      'http://127.0.0.1:3101',
    ])
  })

  it('normalizes trailing slashes on remembered entries before deduplicating', () => {
    const candidates = candidateBaseUrls({
      remembered: ['http://127.0.0.1:3099/'],
      portRangeStart: 3099,
      portRangeCount: 1,
    })
    expect(candidates).toEqual(['http://127.0.0.1:3099'])
  })
})

describe('discoverDaemons', () => {
  it('returns every responding daemon with its baseUrl, in candidate order', async () => {
    const probeFn = probeMap({
      'http://127.0.0.1:3099': DETECTED('a'),
      'http://127.0.0.1:3101': DETECTED('b'),
    })
    const { found, failures } = await discoverDaemons({
      candidates: candidateBaseUrls({ remembered: [], portRangeStart: 3099, portRangeCount: 4 }),
      probeFn,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      pageOriginScheme: 'http',
    })
    expect(found.map((f) => f.baseUrl)).toEqual(['http://127.0.0.1:3099', 'http://127.0.0.1:3101'])
    expect(found.map((f) => f.instanceId)).toEqual(['a', 'b'])
    expect(failures).toHaveLength(2)
  })

  it('deduplicates two baseUrls answered by the same daemon instance', async () => {
    // A remembered URL and a scanned port can name the same daemon.
    const probeFn = probeMap({
      'http://localhost:3099': DETECTED('same'),
      'http://127.0.0.1:3099': DETECTED('same'),
    })
    const { found } = await discoverDaemons({
      candidates: ['http://localhost:3099', 'http://127.0.0.1:3099'],
      probeFn,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      pageOriginScheme: 'http',
    })
    expect(found).toHaveLength(1)
    expect(found[0]?.baseUrl).toBe('http://localhost:3099')
  })

  it('returns empty when nothing responds', async () => {
    const { found } = await discoverDaemons({
      candidates: candidateBaseUrls({ remembered: [], portRangeStart: 3099, portRangeCount: 2 }),
      probeFn: probeMap({}),
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      pageOriginScheme: 'http',
    })
    expect(found).toEqual([])
  })
})

describe('rememberKnownDaemon', () => {
  it('prepends the baseUrl, most recent first, deduplicated and capped', () => {
    expect(rememberKnownDaemon(['http://a', 'http://b'], 'http://b')).toEqual([
      'http://b',
      'http://a',
    ])
    const many = ['1', '2', '3', '4', '5'].map((n) => `http://127.0.0.1:310${n}`)
    const next = rememberKnownDaemon(many, 'http://127.0.0.1:3199')
    expect(next).toHaveLength(5)
    expect(next[0]).toBe('http://127.0.0.1:3199')
  })
})
