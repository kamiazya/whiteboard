use super::*;
use crate::index_rules::NodeKind;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn node(kind: NodeKind, path: &str) -> Node {
    Node { kind, path: path.to_owned(), name: None, document_id: None }
}

fn document(path: &str) -> Node {
    node(NodeKind::Document, path)
}

fn folder(path: &str) -> Node {
    node(NodeKind::Folder, path)
}

#[test]
fn a_workspace_may_reach_the_document_ceiling_and_not_pass_it() {
    assert_eq!(refuse_new_documents(1999, 1), Ok(()));
    assert_eq!(
        refuse_new_documents(2000, 1),
        Err(IndexError::TooManyDocuments { documents: 2001 })
    );
    assert_eq!(refuse_new_documents(1998, 2), Ok(()));
    assert_eq!(
        refuse_new_documents(1998, 3),
        Err(IndexError::TooManyDocuments { documents: 2001 })
    );
}

#[test]
fn a_write_that_adds_no_document_is_taken_by_a_workspace_already_past_the_ceiling() {
    assert_eq!(refuse_new_documents(2500, 0), Ok(()));
    assert_eq!(
        refuse_new_documents(usize::MAX, 1),
        Err(IndexError::TooManyDocuments { documents: usize::MAX })
    );
}

#[test]
fn a_workspace_may_reach_the_folder_ceiling_and_not_pass_it() {
    assert_eq!(refuse_new_folders(3999, 1), Ok(()));
    assert_eq!(refuse_new_folders(4000, 1), Err(IndexError::TooManyFolders { folders: 4001 }));
    assert_eq!(refuse_new_folders(3990, 10), Ok(()));
    assert_eq!(refuse_new_folders(3990, 11), Err(IndexError::TooManyFolders { folders: 4001 }));
    assert_eq!(refuse_new_folders(4500, 0), Ok(()));
}

#[test]
fn the_ceilings_are_the_models() {
    assert_eq!(WORKSPACE_MAX_DOCUMENTS, 2000);
    assert_eq!(WORKSPACE_MAX_FOLDERS, 4000);
}

#[test]
fn documents_and_folders_are_counted_apart() {
    let nodes = [document("a"), folder("b"), document("b/d"), document("b/e")];
    assert_eq!(documents_in(&nodes), 3);
    assert_eq!(folders_in(&nodes), 1);
    assert_eq!((documents_in(&[]), folders_in(&[])), (0, 0));
}

#[test]
fn a_placement_creates_one_folder_for_each_ancestor_no_node_holds() {
    let nodes = [folder("a"), document("a/b")];
    assert_eq!(folders_missing_for(&nodes, "z"), 0);
    assert_eq!(folders_missing_for(&nodes, "a/b"), 0);
    assert_eq!(folders_missing_for(&nodes, "a/b/c"), 0);
    assert_eq!(folders_missing_for(&nodes, "a/x/c"), 1);
    assert_eq!(folders_missing_for(&nodes, "x/y/z"), 2);
    assert_eq!(folders_missing_for(&nodes, "a/b/c/d/e"), 2);
}

#[test]
fn a_placement_is_refused_for_the_folders_it_would_create() {
    let mut nodes: Vec<Node> = (0..3999).map(|n| folder(&format!("f{n}"))).collect();
    assert_eq!(refuse_new_folders_at(&nodes, "f1/doc"), Ok(()));
    assert_eq!(refuse_new_folders_at(&nodes, "new/doc"), Ok(()));
    nodes.push(folder("f3999"));
    assert_eq!(
        refuse_new_folders_at(&nodes, "new/doc"),
        Err(IndexError::TooManyFolders { folders: 4001 })
    );
    assert_eq!(refuse_new_folders_at(&nodes, "f1/doc"), Ok(()));
}
