/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
type Paint = 'icon' | 'image'

export type Op =
  | { o: 'push'; t: string; p?: Paint; w: number }
  | { o: 'placed'; t: string; p?: Paint }
  | { o: 'breakable'; t: string; p?: Paint }
  | { o: 'head'; t: string; p?: Paint }
  | { o: 'tail'; t: string; p?: Paint }
  | { o: 'allow' }
  | { o: 'start' }
  | { o: 'reloc' }

export interface EdgeRecord {
  kind: 'edge'
  t: string
  p?: Paint
  head: string
  tail: string
}

export interface JunctionRecord {
  kind: 'junction'
  ops: Op[]
  out: (boolean | string | null)[]
  runs: [string, string][]
  line: { x: string; index: number }
}
