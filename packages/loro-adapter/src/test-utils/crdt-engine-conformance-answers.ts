/**
 * The conformance cases for what an engine answers a keeper beyond the first
 * surface: the facts it states about a document (where a container sits, what a
 * point had seen, where history starts, how one document of a record measures)
 * and how it judges what it is given (a refusal's detail, an import that
 * activates parked operations).
 */
import type { CrdtEngine } from '../engine/types.js'
import { describeActivationJudging } from './crdt-engine-conformance-activation.js'
import { describeBreachDetail } from './crdt-engine-conformance-breach-detail.js'
import { describeContainerPlace } from './crdt-engine-conformance-container-place.js'
import { describeDocumentReaders } from './crdt-engine-conformance-document-readers.js'
import { describeShallowRoot } from './crdt-engine-conformance-shallow.js'
import { describeVersionAt } from './crdt-engine-conformance-version-at.js'

export function describeEngineAnswers(makeEngine: () => CrdtEngine) {
  describeBreachDetail(makeEngine)
  describeDocumentReaders(makeEngine)
  describeContainerPlace(makeEngine)
  describeVersionAt(makeEngine)
  describeShallowRoot(makeEngine)
  describeActivationJudging(makeEngine)
}
