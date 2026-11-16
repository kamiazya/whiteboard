export type TextRecord =
  | { kind: 'text'; c: string; t: string; b: number[] }
  | { kind: 'text'; c: string; u: number[]; b: number[] }

export interface DigestRecord {
  kind: 'digest'
  c: string
  k: number
  n: number
  h: number
}

interface MetaRecord {
  kind: 'meta'
  version: string
  reps: number[]
  alphabet: number[]
  mixed: unknown
  kanji: number
  latin: [number, number]
}

export type OracleRecord = MetaRecord | TextRecord | DigestRecord
