//! A record at the document ceiling answers a listing and a write in time that
//! grows with its size, not with its size squared: a read resolves the tree once
//! and not once for each node it reads. Each test is one operation over a record
//! of two thousand documents, so a quadratic read shows as a test that does not
//! finish, and the two are timed apart by running them one at a time.

#[cfg(test)]
mod cases {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_crdt::{ExportMode, LoroDoc};
    use whiteboard_workspace_index::{
        CreateDocument, DuplicateDocument, WorkspaceRecord, create_document, duplicate_document,
        list_documents,
    };

    const DOCUMENTS: usize = 2000;
    const WORKSPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    fn id_of(n: usize) -> String {
        format!("01ARZ3NDEKTSV4RRFF{n:08}")
    }

    /// A record holding `count` root documents, opened as the peer a keeper writes as.
    fn record_of(count: usize) -> WorkspaceRecord {
        let doc = LoroDoc::new();
        let tree = doc.get_tree("tree");
        for at in 0..count {
            let node = tree.create(None).expect("a node");
            let meta = tree.get_meta(node).expect("meta");
            meta.insert("documentId", id_of(at).as_str()).expect("set");
            meta.insert("segment", format!("d{at}").as_str()).expect("set");
            meta.insert("kind", "markdown").expect("set");
        }
        doc.commit();
        let bytes = doc.export(ExportMode::Snapshot).expect("a snapshot");
        WorkspaceRecord::open_as(&bytes, 1).expect("a snapshot opens")
    }

    #[test]
    fn a_listing_over_a_record_at_the_document_ceiling_reads_every_document() {
        let record = record_of(DOCUMENTS);
        assert_eq!(list_documents(&record).expect("a listing").len(), DOCUMENTS);
    }

    #[test]
    fn a_create_in_a_record_one_short_of_the_ceiling_takes_the_last_place() {
        let record = record_of(DOCUMENTS - 1);
        let input =
            CreateDocument { workspace_id: WORKSPACE, path: "fresh", kind: "markdown", name: None };
        let mut mint = || id_of(DOCUMENTS);
        create_document(&record, &input, &mut mint, 1.0).expect("created");
        assert_eq!(record.documents().len(), DOCUMENTS);
    }

    #[test]
    fn a_create_in_a_full_record_is_refused_and_a_duplicate_too() {
        let record = record_of(DOCUMENTS);
        let input =
            CreateDocument { workspace_id: WORKSPACE, path: "fresh", kind: "markdown", name: None };
        let mut mint = || id_of(DOCUMENTS + 1);
        let refused = create_document(&record, &input, &mut mint, 1.0).expect_err("no room");
        assert_eq!(
            refused,
            whiteboard_workspace_index::IndexError::TooManyDocuments { documents: 2001 }
        );
        let duplicate =
            DuplicateDocument { workspace_id: WORKSPACE, path: "d0", without_annotations: false };
        assert_eq!(
            duplicate_document(&record, &duplicate, &mut mint, 1.0).expect_err("no room"),
            whiteboard_workspace_index::IndexError::TooManyDocuments { documents: 2001 }
        );
    }
}
