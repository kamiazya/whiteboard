/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
export interface FitRecord {
  kind: 'fit'
  t: string
  f: string
  s: string
  m: string
  r: string
  tr: boolean
  ov: boolean
  w: string
  calls: number[]
}

export interface FitAnswer {
  r: string
  tr: boolean
  ov: boolean
  w: string
  calls: number[]
}

export interface UaxRecord {
  kind: 'uax'
  t: string
  s: string[]
  e: number[]
}

export interface GraphemeRecord {
  kind: 'grapheme'
  t: string
  g: number[]
}

export interface LongestRecord {
  kind: 'longest'
  limit: number
  guess: number
  threshold: number
  r: number
  p: number[]
}

export interface DigestRecord {
  kind: 'digest'
  c: string
  k: number
  n: number
  h: number
}
