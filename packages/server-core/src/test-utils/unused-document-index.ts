import type { DocumentIndex } from '@kamiazya/whiteboard-ports'

/**
 * A `DocumentIndex` for tests whose subject is elsewhere. Every method
 * throws, so a test that starts depending on placement fails loudly here
 * instead of passing against a double that quietly answers.
 *
 * Deliberately not a working in-memory store: two of those already exist
 * (the sqlite one and the DI module's), both held to the conformance suite,
 * and a third that nothing checks is exactly how two implementations of one
 * rule start to disagree.
 */
export function unusedDocumentIndex(): DocumentIndex {
  const refuse = (operation: string) => () => {
    throw new Error(
      `${operation}: this test composed a DocumentIndex it does not exercise. ` +
        'Compose a real one if the behaviour under test now depends on placement.',
    )
  }
  return {
    createWorkspace: refuse('createWorkspace'),
    createDocument: refuse('createDocument'),
    resolveDocument: refuse('resolveDocument'),
    resolveDocumentById: refuse('resolveDocumentById'),
    listDocuments: refuse('listDocuments'),
    moveDocument: refuse('moveDocument'),
    setDocumentName: refuse('setDocumentName'),
    deleteDocument: refuse('deleteDocument'),
  }
}
