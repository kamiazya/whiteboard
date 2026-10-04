/**
 * No tool pins a document, so a daemon-kept workspace lists every row as not
 * pinned. The field being present at all is what the keeper's pin list
 * answering through `wb_document_list` looks like from here, and an index
 * without the capability would omit it rather than say false.
 */
export function assertListedRowIsNotPinned(row) {
  if (row?.pinned !== false) {
    throw new Error(
      `wb_document_list should say an unpinned document is not: ${JSON.stringify(row)}`,
    )
  }
  console.log('[e2e] wb_document_list → carries pinned from the keeper')
}
