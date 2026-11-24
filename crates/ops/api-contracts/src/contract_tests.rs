//! The generated enum held to the contract file it was generated from, read
//! here independently of the generator.

use std::collections::BTreeSet;

use serde_json::Value;
use whiteboard_ports::{PortError, SnapshotReassemblyCode, StoredUnreadableCode};

use crate::refusals::examples;
use crate::{CODES, Refusal, SYNC_WRITE_CODES, VERSION_CODES};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const CONTRACT: &str = include_str!("../../../../contracts/api/refusals.json");

fn entries() -> Vec<Value> {
    let contract: Value = serde_json::from_str(CONTRACT).unwrap();
    contract["refusals"].as_array().unwrap().clone()
}

#[test]
fn every_entry_of_the_contract_has_its_variant_and_no_other_exists() {
    let built: BTreeSet<&str> = examples().iter().map(|(name, _)| *name).collect();
    let listed = entries();
    let named: BTreeSet<&str> = listed.iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert!(named.len() > 100, "{}", named.len());
    assert_eq!(built.len(), examples().len(), "an example is built twice");
    assert_eq!(built, named);
}

#[test]
fn each_refusal_answers_the_code_status_and_text_the_contract_pins() {
    let built = examples();
    for entry in entries() {
        let name = entry["name"].as_str().unwrap();
        let (_, refusal) = built.iter().find(|(n, _)| *n == name).unwrap();
        assert_eq!(refusal.code(), entry["code"].as_str().unwrap(), "{name}");
        assert_eq!(u64::from(refusal.status()), entry["status"].as_u64().unwrap(), "{name}");
        assert_eq!(refusal.message(), entry["exampleText"].as_str().unwrap(), "{name}");
        assert_eq!(refusal.to_string(), refusal.message(), "{name}");
    }
}

#[test]
fn the_code_lists_are_the_contracts_distinct_codes_and_families() {
    let listed = entries();
    let mut all = Vec::new();
    let mut sync = Vec::new();
    let mut version = Vec::new();
    for entry in &listed {
        let code = entry["code"].as_str().unwrap();
        if !all.contains(&code) {
            all.push(code);
        }
        let family = match entry["family"].as_str() {
            Some("sync-write") => Some(&mut sync),
            Some("version") => Some(&mut version),
            _ => None,
        };
        if let Some(family) = family
            && !family.contains(&code)
        {
            family.push(code);
        }
    }
    assert_eq!(CODES, all.as_slice());
    assert_eq!(SYNC_WRITE_CODES, sync.as_slice());
    assert_eq!(VERSION_CODES, version.as_slice());
    assert!(SYNC_WRITE_CODES.len() > 20 && !VERSION_CODES.is_empty());
}

fn s(text: &str) -> String {
    text.to_owned()
}

/// Every way a port fails, with whether its own sentence is the refusal's.
fn port_errors() -> Vec<(PortError, bool)> {
    vec![
        (PortError::WorkspaceNotFound { workspace_id: s("w") }, true),
        (PortError::DocumentNotFound { workspace_id: s("w"), target: s("a/b") }, true),
        (PortError::DatabaseBusy, false),
        (
            PortError::StoredDocumentUnreadable {
                code: StoredUnreadableCode::UnsupportedVersion,
                message: s("v9"),
            },
            true,
        ),
        (
            PortError::StoredDocumentUnreadable {
                code: StoredUnreadableCode::Malformed,
                message: s("bad"),
            },
            true,
        ),
        (
            PortError::StoredDocumentUnreadable {
                code: StoredUnreadableCode::RetiredEnvelope,
                message: s("old"),
            },
            true,
        ),
        (
            PortError::SnapshotReassembly {
                code: SnapshotReassemblyCode::MissingChunk,
                message: s("gap"),
            },
            true,
        ),
        (PortError::TooManyWorkspaces { namespace: s("ns"), limit: 1000 }, true),
        (PortError::TooManyDocuments { documents: 2001, limit: 2000 }, true),
        (PortError::TooManyFolders { folders: 4001, limit: 4000 }, true),
        (PortError::TooManyVersions { limit: 200 }, true),
        (PortError::InvalidTime, false),
    ]
}

#[test]
fn a_port_failure_travels_under_the_code_the_port_names_for_it() {
    for (error, same_text) in port_errors() {
        let refusal = Refusal::from(&error);
        assert!(CODES.contains(&refusal.code()), "{error:?}");
        assert_eq!(refusal.code(), error.code(), "{error:?}");
        if same_text {
            assert_eq!(refusal.message(), error.to_string(), "{error:?}");
        }
    }
}

#[test]
fn the_refusals_that_say_something_other_than_their_port_do_so_on_purpose() {
    let busy = Refusal::from(&PortError::DatabaseBusy);
    assert_eq!((busy.status(), busy.message()), (503, s("The database is busy; retry shortly.")));
    let time = Refusal::from(&PortError::InvalidTime);
    assert_eq!((time.status(), time.code()), (500, "internal_error"));
}
