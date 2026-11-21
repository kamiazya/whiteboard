import { encodeFrontiers, type LoroDoc } from 'loro-crdt'

/** What a test hands the checkpoint scheduler to say what state a document stands at. */
export const subjectOf = (doc: LoroDoc) => (): Uint8Array => encodeFrontiers(doc.oplogFrontiers())
