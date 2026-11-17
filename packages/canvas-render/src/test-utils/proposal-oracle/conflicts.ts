import type { CanvasWire } from '../compose-canvas-oracle/wire.js'
import type { ChangeWire } from './wire.js'

/**
 * The recorded answers of `canvasChangeConflicts` (model's
 * `proposal-apply.ts`, ADR-0029 decision 5): every canvas arm against a board
 * that holds each node kind, edges and ink, with priors that agree, disagree
 * and say nothing, field by field. Every change is a fresh parse of its JSON,
 * as a proposal read from the record is, so no prior shares an object with
 * the board and an end, a bend list or a facet bucket agrees only by value.
 * `structuredClone` rather than a JSON round trip, which would turn a `-0`
 * the board holds into `0`.
 */

interface BoardRecord {
  readonly kind: 'board'
  readonly name: string
  readonly canvas: CanvasWire
}

interface CaseRecord {
  readonly kind: 'case'
  readonly board: string
  readonly change: ChangeWire
  readonly conflicts: boolean
}

export type ProposalConflictsRecord = BoardRecord | CaseRecord
