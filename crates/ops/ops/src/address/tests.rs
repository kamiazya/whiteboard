use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_port_fakes::{
    FixedCaller, MemoryRecordStore, MemoryRegistry, MemoryVersionStore, block_on,
};

const W: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const X: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

struct Fakes {
    records: MemoryRecordStore,
    registry: MemoryRegistry,
    caller: FixedCaller,
}

impl Ports for Fakes {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = FixedCaller;
    type Versions = MemoryVersionStore;

    fn records(&self) -> &MemoryRecordStore {
        &self.records
    }

    fn registry(&self) -> &MemoryRegistry {
        &self.registry
    }

    fn caller(&self) -> &FixedCaller {
        &self.caller
    }

    fn versions(&self) -> &MemoryVersionStore {
        unreachable!("an address reads no version")
    }
}

fn row(id: &str, namespace: Option<&str>, segment: Option<&str>) -> WorkspaceEntry {
    WorkspaceEntry {
        workspace_id: id.to_owned(),
        namespace: namespace.map(str::to_owned),
        segment: segment.map(str::to_owned),
    }
}

/// `W` as `plan` in `me`, `X` as `plan` in `ann`.
fn fakes(caller: FixedCaller) -> Fakes {
    Fakes {
        records: MemoryRecordStore::new(),
        registry: MemoryRegistry::new().holding(row(W, None, Some("plan"))).holding(row(
            X,
            Some("ann"),
            Some("plan"),
        )),
        caller,
    }
}

fn qualified(namespace: &str, segment: &str) -> WorkspaceAddress {
    WorkspaceAddress::Qualified { namespace: namespace.to_owned(), segment: segment.to_owned() }
}

#[test]
fn an_address_parses_as_the_one_form_it_spells() {
    assert_eq!(parse_workspace_address(W), Some(WorkspaceAddress::Id(W.to_owned())));
    assert_eq!(parse_workspace_address("plan"), Some(WorkspaceAddress::Bare("plan".to_owned())));
    assert_eq!(parse_workspace_address("a-b"), Some(WorkspaceAddress::Bare("a-b".to_owned())));
    assert_eq!(parse_workspace_address("me/plan"), Some(qualified("me", "plan")));
    assert_eq!(parse_workspace_address("Ann/C-9"), Some(qualified("Ann", "C-9")));
}

#[test]
fn what_spells_no_form_is_no_address() {
    let lower = W.to_ascii_lowercase();
    let ulid_namespace = format!("{W}/plan");
    let ulid_segment = format!("me/{W}");
    let long = "a".repeat(201);
    for text in [
        "",
        "-",
        "a-",
        "-a",
        "a_b",
        "a/b/c",
        "/a",
        "a/",
        "a//b",
        "ü",
        lower.as_str(),
        ulid_namespace.as_str(),
        ulid_segment.as_str(),
        long.as_str(),
    ] {
        assert_eq!(parse_workspace_address(text), None, "{text:?}");
    }
    assert!(parse_workspace_address(&"a".repeat(200)).is_some());
}

#[test]
fn each_form_resolves_in_its_own_namespace() {
    let mine = fakes(FixedCaller::new());
    let resolve = |ports: &Fakes, handle: &str| {
        block_on(resolve_workspace(ports, handle)).expect("resolves").map(|row| row.workspace_id)
    };
    assert_eq!(resolve(&mine, W).as_deref(), Some(W));
    assert_eq!(resolve(&mine, X).as_deref(), Some(X));
    assert_eq!(resolve(&mine, "plan").as_deref(), Some(W));
    assert_eq!(resolve(&mine, "me/plan").as_deref(), Some(W));
    assert_eq!(resolve(&mine, "ann/plan").as_deref(), Some(X));
    assert_eq!(resolve(&mine, "Plan"), None);
    assert_eq!(resolve(&mine, "a_b"), None);
    let anns = fakes(FixedCaller::new().in_namespace("ann"));
    assert_eq!(resolve(&anns, "plan").as_deref(), Some(X));
    assert_eq!(resolve(&anns, "me/plan").as_deref(), Some(W));
}

/// The id the operation was handed, or its refusal.
fn run(ports: &Fakes, handle: &str, refusal: Option<Refusal>) -> Result<String, Refusal> {
    block_on(with_resolved_workspace(
        ports,
        handle,
        |id| async move { refusal.map_or(Ok(id), Err) },
    ))
}

#[test]
fn the_operation_runs_over_the_canonical_id() {
    let ports = fakes(FixedCaller::new());
    assert_eq!(run(&ports, "plan", None).as_deref(), Ok(W));
    assert_eq!(run(&ports, "ann/plan", None).as_deref(), Ok(X));
}

#[test]
fn an_address_nothing_answers_to_is_refused_naming_what_the_caller_may_see() {
    let unknown = |caller| run(&fakes(caller), "nope", None).expect_err("refused");
    assert_eq!(
        unknown(FixedCaller::new()),
        Refusal::WorkspaceNotFoundForCallerRead { workspace_id: "nope".into() }
    );
    assert_eq!(
        unknown(FixedCaller::new().knowing(Vec::new())),
        Refusal::WorkspaceNotFoundForCallerRead { workspace_id: "nope".into() }
    );
    assert_eq!(
        unknown(FixedCaller::new().knowing(vec!["plan".into()])),
        Refusal::WorkspaceNotFoundForCallerReadKnown {
            known: vec!["plan".into()],
            workspace_id: "nope".into()
        }
    );
}

#[test]
fn a_failing_port_is_answered_with_its_own_refusal() {
    let busy = whiteboard_ports::PortError::DatabaseBusy;
    let caller = fakes(FixedCaller::failing(busy.clone()));
    assert_eq!(run(&caller, W, None), Err(Refusal::DatabaseBusy));
    let mut registry = fakes(FixedCaller::new());
    registry.registry = MemoryRegistry::failing(busy);
    assert_eq!(run(&registry, W, None), Err(Refusal::DatabaseBusy));
}

#[test]
fn a_refusal_quoting_the_id_is_said_with_the_handle_the_caller_typed() {
    let ports = fakes(FixedCaller::new());
    let refused = |refusal: Refusal| run(&ports, "plan", Some(refusal)).expect_err("refused");
    assert_eq!(
        refused(Refusal::WorkspaceNotFoundForCallerRead { workspace_id: W.into() }),
        Refusal::WorkspaceNotFoundForCallerRead { workspace_id: "plan".into() }
    );
    assert_eq!(
        refused(Refusal::WorkspaceNotFoundForCallerReadKnown {
            known: vec![X.into(), W.into()],
            workspace_id: W.into()
        }),
        Refusal::WorkspaceNotFoundForCallerReadKnown {
            known: vec![X.into(), "plan".into()],
            workspace_id: "plan".into()
        }
    );
    let message = format!("stored workspace document {W} could not be imported: {W}");
    assert_eq!(
        refused(Refusal::CorruptStoredData { message: message.clone() }),
        Refusal::CorruptStoredData {
            message: "stored workspace document plan could not be imported: plan".into()
        }
    );
    assert_eq!(
        refused(Refusal::StoredDocumentUnsupportedVersion { message }),
        Refusal::StoredDocumentUnsupportedVersion {
            message: "stored workspace document plan could not be imported: plan".into()
        }
    );
    assert_eq!(
        refused(Refusal::DocumentNotFound { document_id: W.into(), workspace_id: W.into() }),
        Refusal::DocumentNotFound { document_id: "plan".into(), workspace_id: "plan".into() }
    );
    assert_eq!(refused(Refusal::DatabaseBusy), Refusal::DatabaseBusy);
}

/// A caller in `me` whose known handles cannot be read.
struct Unreadable;

impl Caller for Unreadable {
    async fn namespace(&self) -> Result<String, PortError> {
        Ok("me".to_owned())
    }

    async fn known_workspace_handles(&self) -> Result<Option<Vec<String>>, PortError> {
        Err(PortError::DatabaseBusy)
    }
}

impl Ports for (MemoryRegistry, Unreadable) {
    type Records = MemoryRecordStore;
    type Registry = MemoryRegistry;
    type Caller = Unreadable;
    type Versions = MemoryVersionStore;

    fn records(&self) -> &MemoryRecordStore {
        unreachable!("an unknown address reads no record")
    }

    fn registry(&self) -> &MemoryRegistry {
        &self.0
    }

    fn caller(&self) -> &Unreadable {
        &self.1
    }

    fn versions(&self) -> &MemoryVersionStore {
        unreachable!("an address reads no version")
    }
}

#[test]
fn known_handles_that_cannot_be_read_are_answered_with_their_failure() {
    let ports = (MemoryRegistry::new(), Unreadable);
    let refused = block_on(with_resolved_workspace(&ports, "nope", |_| async { Ok(()) }));
    assert_eq!(refused, Err(Refusal::DatabaseBusy));
}
