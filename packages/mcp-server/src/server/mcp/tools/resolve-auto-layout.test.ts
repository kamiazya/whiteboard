import { describe, it, expect } from 'vitest'
import { resolveAutoLayout } from './resolve-auto-layout.js'

describe('resolveAutoLayout', () => {
  it('case 275', () => {
    const r = resolveAutoLayout({
      nodes: [{ id: 'a', width: 100, height: 60 }],
      edges: [],
      config: { direction: 'TB', origin: { x: 0, y: 0 }, layerGap: 60, nodeGap: 40 },
    })
    const pos = r.positions.get('a')
    expect(pos).toBeDefined()
    expect(pos).toEqual({ x: 0, y: 0 })
  })

  it('case 276', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'a', width: 100, height: 60 },
        { id: 'b', width: 100, height: 60 },
        { id: 'c', width: 100, height: 60 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
      config: { direction: 'TB', origin: { x: 0, y: 0 }, layerGap: 60, nodeGap: 40 },
    })
    const pa = r.positions.get('a')!
    const pb = r.positions.get('b')!
    const pc = r.positions.get('c')!
    expect(pa.x).toBe(0)
    expect(pb.x).toBe(0)
    expect(pc.x).toBe(0)
    expect(pa.y).toBe(0)
    expect(pb.y).toBe(120)
    expect(pc.y).toBe(240)
  })

  it('case 277', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'a', width: 100, height: 60 },
        { id: 'b', width: 100, height: 60 },
        { id: 'c', width: 100, height: 60 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'a', target: 'c' },
      ],
      config: { direction: 'TB', origin: { x: 0, y: 0 }, layerGap: 60, nodeGap: 40 },
    })
    const pa = r.positions.get('a')!
    const pb = r.positions.get('b')!
    const pc = r.positions.get('c')!
    expect(pa).toEqual({ x: 0, y: 0 })
    expect(pb.y).toBe(120)
    expect(pc.y).toBe(120)
    expect(pb.x).not.toBe(pc.x)
    const leftNode = pb.x < pc.x ? pb : pc
    const rightNode = pb.x < pc.x ? pc : pb
    expect(rightNode.x - (leftNode.x + 100)).toBe(40)
    expect(leftNode.x).toBe(0)
  })

  it('case 278', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'a', width: 100, height: 60 },
        { id: 'b', width: 100, height: 60 },
      ],
      edges: [],
      config: { direction: 'TB', origin: { x: 0, y: 0 }, layerGap: 60, nodeGap: 40 },
    })
    const pa = r.positions.get('a')!
    const pb = r.positions.get('b')!
    expect(pa.y).toBe(0)
    expect(pb.y).toBe(0)
    expect(pa.x).not.toBe(pb.x)
    expect(Math.min(pa.x, pb.x)).toBe(0)
  })

  it('case 279', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'a', width: 100, height: 60 },
        { id: 'b', width: 100, height: 60 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
      config: { direction: 'LR', origin: { x: 0, y: 0 }, layerGap: 80, nodeGap: 40 },
    })
    const pa = r.positions.get('a')!
    const pb = r.positions.get('b')!
    expect(pa.y).toBe(0)
    expect(pb.y).toBe(0)
    expect(pa.x).toBe(0)
    expect(pb.x).toBe(180)
  })

  it('case 280', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'a', width: 100, height: 60 },
        { id: 'b', width: 100, height: 60 },
        { id: 'c', width: 100, height: 60 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
        { id: 'e3', source: 'c', target: 'a' }, // Cycle
      ],
      config: { direction: 'TB', origin: { x: 0, y: 0 }, layerGap: 60, nodeGap: 40 },
    })
    expect(r.positions.size).toBe(3)
    expect(r.positions.get('a')).toBeDefined()
    expect(r.positions.get('b')).toBeDefined()
    expect(r.positions.get('c')).toBeDefined()
  })

  it('case 281', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'big', width: 400, height: 60 },
        { id: 'small', width: 50, height: 60 },
      ],
      edges: [],
      config: { direction: 'TB', origin: { x: 0, y: 0 }, layerGap: 60, nodeGap: 40 },
    })
    const pb = r.positions.get('big')!
    const ps = r.positions.get('small')!
    const bigRight = pb.x + 400
    const smallLeft = ps.x
    const gap =
      pb.x < ps.x
        ? ps.x - (pb.x + 400)
        : pb.x - (ps.x + 50)
    expect(gap).toBeGreaterThanOrEqual(40)
    // sanity
    expect(Number.isFinite(bigRight) && Number.isFinite(smallLeft)).toBe(true)
  })
})
describe('resolveAutoLayout: pins', () => {
  it('case 282', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'a', width: 100, height: 60 },
        { id: 'b', width: 100, height: 60 },
        { id: 'c', width: 100, height: 60 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
      config: {
        direction: 'TB',
        origin: { x: 0, y: 0 },
        layerGap: 100,
        nodeGap: 40,
        pins: [{ id: 'a', rank: 2 }],
      },
    })
    const pa = r.positions.get('a')!
    const pb = r.positions.get('b')!
    const pc = r.positions.get('c')!
    expect(pa.y).toBeGreaterThan(pb.y)
  })

  it('case 283', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'user', width: 100, height: 60 },
        { id: 'svc', width: 100, height: 60 },
        { id: 'partner', width: 100, height: 60 },
      ],
      edges: [
      ],
      config: {
        direction: 'LR',
        origin: { x: 0, y: 0 },
        layerGap: 100,
        nodeGap: 40,
        pins: [
          { id: 'user', anchor: 'left' },
          { id: 'partner', anchor: 'right' },
          { id: 'svc', anchor: 'center' },
        ],
      },
    })
    const u = r.positions.get('user')!
    const s = r.positions.get('svc')!
    const p = r.positions.get('partner')!
    expect(u.x).toBeLessThan(s.x)
    expect(s.x).toBeLessThan(p.x)
  })

  it('case 284', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'entry', width: 100, height: 60 },
        { id: 'end', width: 100, height: 60 },
      ],
      edges: [],
      config: {
        direction: 'TB',
        origin: { x: 0, y: 0 },
        layerGap: 100,
        nodeGap: 40,
        pins: [
          { id: 'entry', anchor: 'top' },
          { id: 'end', anchor: 'bottom' },
        ],
      },
    })
    const a = r.positions.get('entry')!
    const b = r.positions.get('end')!
    expect(a.y).toBeLessThan(b.y)
  })

  it('case 285', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'a', width: 100, height: 60 },
        { id: 'b', width: 100, height: 60 },
        { id: 'c', width: 100, height: 60 },
        { id: 'd', width: 100, height: 60 },
        { id: 'e', width: 100, height: 60 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
        { id: 'e3', source: 'c', target: 'd' },
        { id: 'e4', source: 'd', target: 'e' },
      ],
      config: {
        direction: 'TB',
        origin: { x: 0, y: 0 },
        layerGap: 100,
        nodeGap: 40,
        pins: [{ id: 'a', rank: 4 }],
      },
    })
    const pa = r.positions.get('a')!
    const pe = r.positions.get('e')!
    expect(pa.y).toBeGreaterThan(pe.y)
  })

  it('case 286', () => {
    expect(() =>
      resolveAutoLayout({
        nodes: [{ id: 'a', width: 100, height: 60 }],
        edges: [],
        config: {
          pins: [{ id: 'ghost', rank: 5 }],
        },
      }),
    ).not.toThrow()
  })

  it('case 287', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'b', width: 100, height: 60 },
        { id: 'c', width: 100, height: 60 },
        { id: 'a', width: 100, height: 60 },
      ],
      edges: [],
      config: {
        direction: 'TB',
        origin: { x: 0, y: 0 },
        layerGap: 60,
        nodeGap: 40,
        pins: [
          { id: 'a', column: 0 },
          { id: 'b', column: 1 },
          { id: 'c', column: 2 },
        ],
      },
    })
    const pa = r.positions.get('a')!
    const pb = r.positions.get('b')!
    const pc = r.positions.get('c')!
    expect(pa.y).toBe(0)
    expect(pb.y).toBe(0)
    expect(pc.y).toBe(0)
    expect(pa.x).toBeLessThan(pb.x)
    expect(pb.x).toBeLessThan(pc.x)
  })

  it('case 288', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'c', width: 100, height: 60 },
        { id: 'a', width: 100, height: 60 },
        { id: 'b', width: 100, height: 60 },
      ],
      edges: [],
      config: {
        direction: 'TB',
        origin: { x: 0, y: 0 },
        layerGap: 60,
        nodeGap: 40,
        pins: [
          { id: 'a', column: 0 },
          { id: 'b', column: 1 },
        ],
      },
    })
    const pa = r.positions.get('a')!
    const pb = r.positions.get('b')!
    const pc = r.positions.get('c')!
    expect(pa.x).toBeLessThan(pb.x)
    expect(pb.x).toBeLessThan(pc.x)
  })

  it('case 289', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'oa', width: 200, height: 60 },
        { id: 'os', width: 200, height: 60 },
        { id: 'odb', width: 200, height: 60 },
        { id: 'pa', width: 200, height: 60 },
        { id: 'ps', width: 200, height: 60 },
        { id: 'pdb', width: 200, height: 60 },
      ],
      edges: [
        { id: 'e1', source: 'oa', target: 'os' },
        { id: 'e2', source: 'os', target: 'odb' },
        { id: 'e3', source: 'pa', target: 'ps' },
        { id: 'e4', source: 'ps', target: 'pdb' },
      ],
      config: {
        direction: 'TB',
        origin: { x: 0, y: 0 },
        layerGap: 60,
        nodeGap: 40,
        groupGap: 80,
        groups: [
          { id: 'orders', elementIds: ['oa', 'os', 'odb'] },
          { id: 'payments', elementIds: ['pa', 'ps', 'pdb'] },
        ],
      },
    })
    const poa = r.positions.get('oa')!
    const pos = r.positions.get('os')!
    const podb = r.positions.get('odb')!
    const ppa = r.positions.get('pa')!
    expect(poa.x).toBe(pos.x)
    expect(pos.x).toBe(podb.x)
    expect(poa.y).toBeLessThan(pos.y)
    expect(pos.y).toBeLessThan(podb.y)
    expect(ppa.x).toBeGreaterThan(poa.x)
    expect(poa.y).toBe(ppa.y)
  })

  it('case 290', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'free', width: 100, height: 60 },
        { id: 'ga', width: 100, height: 60 },
        { id: 'gb', width: 100, height: 60 },
      ],
      edges: [{ id: 'e', source: 'ga', target: 'gb' }],
      config: {
        direction: 'TB',
        origin: { x: 0, y: 0 },
        layerGap: 60,
        nodeGap: 40,
        groupGap: 80,
        groups: [{ id: 'g', elementIds: ['ga', 'gb'] }],
      },
    })
    const pfree = r.positions.get('free')!
    const pga = r.positions.get('ga')!
    expect(pfree.x).toBeLessThan(pga.x)
  })

  it('case 291', () => {
    const r = resolveAutoLayout({
      nodes: [
        { id: 'client', width: 200, height: 60 },
        { id: 'orders-api', width: 200, height: 60 },
        { id: 'payments-api', width: 200, height: 60 },
      ],
      edges: [
        { id: 'e1', source: 'client', target: 'orders-api' },
        { id: 'e2', source: 'client', target: 'payments-api' },
      ],
      config: {
        direction: 'TB',
        origin: { x: 0, y: 0 },
        layerGap: 80,
        nodeGap: 40,
        pins: [
          { id: 'orders-api', column: 0 },
          { id: 'payments-api', column: 1 },
        ],
      },
    })
    const pclient = r.positions.get('client')!
    const pOrders = r.positions.get('orders-api')!
    const pPayments = r.positions.get('payments-api')!
    expect(pclient.y).toBeLessThan(pOrders.y)
    expect(pOrders.y).toBe(pPayments.y)
    expect(pOrders.x).toBeLessThan(pPayments.x)
  })
})
