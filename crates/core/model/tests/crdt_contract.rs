//! The generated CRDT document-engine contract, held against the schema it is
//! generated from: every enum value the schema lists must name a variant both
//! ways, so a value added to the contract is covered without a line here.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::Value;
use whiteboard_model::crdt::{
    Breach, BreachShape, CloseRequest, DecodeKind, DecodeRequest, DecodeResponse, ExportRequest,
    ExportResponse, ExportShallowSnapshotRequest, ExportSnapshotRequest, ExportUpdateRequest,
    ForkRequest, ImportJudge, ImportRequest, ImportSubtreeRequest, MutationApplied,
    MutationRefused, MutationResult, OpenRequest, OpenResponse, PlacedRoot, Query, QueryName,
    ReadRequest, ReadResponse, RedoRequest, TextRun, TextSpliceRequest, UndoClearRequest,
    UndoRequest, UndoStateRequest, UndoStateResponse, VersionEntry, VersionRequest,
    VersionResponse, Write, WriteRequest, WriterName,
};
use whiteboard_model::json::parse;

const SCHEMA: &str = include_str!("../../../../contracts/crdt/document-engine.schema.json");

#[cfg(test)]
mod schema {
    use super::{SCHEMA, Value, parse};

    pub(crate) fn member<'a>(value: &'a Value, key: &str) -> &'a Value {
        let Value::Map(entries) = value else { panic!("{key}: not an object") };
        &entries.iter().find(|(k, _)| k == key).unwrap_or_else(|| panic!("no {key}")).1
    }

    pub(crate) fn enum_values(definition: &str) -> Vec<String> {
        let schema = parse(SCHEMA).expect("the contract parses");
        let Value::Seq(values) = member(member(member(&schema, "$defs"), definition), "enum")
        else {
            panic!("{definition}: no enum")
        };
        values
            .iter()
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => panic!("{definition}: {other:?}"),
            })
            .collect()
    }
}

use schema::enum_values;

macro_rules! wire_enum_covered {
    ($name:ident, $enum:ident, $floor:expr) => {
        #[test]
        fn $name() {
            let wires = enum_values(stringify!($enum));
            assert!(wires.len() >= $floor, "the schema lists {} values", wires.len());
            for wire in &wires {
                let variant = $enum::from_wire(wire).unwrap_or_else(|| panic!("{wire} unread"));
                assert_eq!(variant.as_str(), wire);
                assert_eq!($enum::from_wire(&format!("{wire}-x")), None);
            }
            assert_eq!($enum::from_wire(""), None);
            assert_eq!($enum::default().as_str(), wires[0]);
            for (i, a) in wires.iter().enumerate() {
                for b in &wires[i + 1..] {
                    assert_ne!($enum::from_wire(a), $enum::from_wire(b));
                }
            }
        }
    };
}

wire_enum_covered!(every_breach_shape_round_trips, BreachShape, 28);
wire_enum_covered!(every_query_name_round_trips, QueryName, 33);
wire_enum_covered!(every_writer_name_round_trips, WriterName, 47);
wire_enum_covered!(every_import_judge_round_trips, ImportJudge, 3);
wire_enum_covered!(every_decode_kind_round_trips, DecodeKind, 2);

#[test]
fn a_union_defaults_to_its_first_member_and_each_constant_is_the_contract_tag() {
    assert_eq!(
        ExportRequest::default(),
        ExportRequest::ExportSnapshotRequest(ExportSnapshotRequest::default())
    );
    assert_eq!(
        MutationResult::default(),
        MutationResult::MutationApplied(MutationApplied::default())
    );
    assert_eq!(ExportSnapshotRequest::MODE, "snapshot");
    assert_eq!(ExportUpdateRequest::MODE, "update");
    assert_eq!(ExportShallowSnapshotRequest::MODE, "shallow-snapshot");
    assert_eq!(MutationApplied::OUTCOME, "applied");
    assert_eq!(MutationRefused::OUTCOME, "refused");
}

#[test]
fn every_message_defaults_empty_and_clones_equal_with_an_unsigned_index() {
    let splice = TextSpliceRequest {
        handle: 3,
        document_id: Some("doc".into()),
        text: "body".into(),
        runs: vec![TextRun { index: u64::MAX, remove: 0, insert: "x".into() }],
    };
    assert_eq!(splice.clone(), splice);
    assert_ne!(splice, TextSpliceRequest::default());
    assert_eq!(TextRun::default().index, 0);
    assert!(TextSpliceRequest::default().runs.is_empty());

    let update = ExportUpdateRequest {
        handle: 1,
        from: Some(vec![VersionEntry { peer: "1".into(), counter: -1 }]),
    };
    assert_eq!(
        ExportRequest::ExportUpdateRequest(update.clone()).clone(),
        ExportRequest::ExportUpdateRequest(update)
    );
    let shallow =
        ExportShallowSnapshotRequest { handle: 1, frontiers: vec![VersionEntry::default()] };
    assert_ne!(shallow, ExportShallowSnapshotRequest::default());
}

#[test]
fn results_requests_and_opening_messages_carry_their_fields() {
    let refused = MutationRefused {
        breach: Breach { shape: BreachShape::Body, container: Some("c".into()) },
    };
    assert_ne!(MutationResult::MutationRefused(refused.clone()), MutationResult::default());
    let applied = MutationApplied {
        changed: vec!["d".into()],
        local_update: Some("AA==".into()),
        pending: Some(true),
        root: Some(PlacedRoot { document_id: "d".into(), path: "a/b".into() }),
    };
    assert_eq!(
        MutationResult::MutationApplied(applied.clone()),
        MutationResult::MutationApplied(applied)
    );

    let read = ReadRequest {
        handle: 2,
        query: Query { query: QueryName::Meta, args: Some(Value::Map(vec![])) },
    };
    assert_ne!(read.clone(), ReadRequest::default());
    let write = WriteRequest {
        handle: 2,
        batch: vec![Write { op: WriterName::SetNodeLock, args: Value::Bool(true) }],
    };
    assert_ne!(write.clone(), WriteRequest::default());

    assert_eq!(OpenRequest::default().bytes, None);
    assert_eq!(OpenRequest::default().undo_merge_interval_ms, None);
    assert_eq!(OpenResponse::default().handle, 0);
    assert_eq!(CloseRequest::default(), CloseRequest { handle: 0 });
    assert_eq!(UndoRequest::default(), UndoRequest { handle: 0 });
    assert_eq!(RedoRequest::default(), RedoRequest { handle: 0 });
    assert_eq!(ExportResponse::default().bytes, "");
    assert_eq!(ImportRequest::default().bytes, "");
    assert_eq!(ReadResponse::default().value, Value::Null);
    assert_eq!(Write::default().op, WriterName::WriteSpatialCanvas);
    assert!(format!("{:?}", Breach::default()).contains("Run"));
}

#[test]
fn the_calls_for_judging_versions_forks_and_undo_state_carry_their_fields() {
    assert_eq!(ImportRequest::default().judge, None);
    assert_eq!(ImportJudge::default(), ImportJudge::Text);
    assert_eq!(DecodeKind::default(), DecodeKind::Version);
    assert_eq!(MutationApplied::default().pending, None);
    let decode = DecodeRequest { kind: DecodeKind::Frontiers, bytes: "AA==".into() };
    assert_ne!(decode.clone(), DecodeRequest::default());
    let entries = vec![VersionEntry { peer: "7".into(), counter: 2 }];
    assert_ne!(DecodeResponse { entries: entries.clone() }, DecodeResponse::default());
    let version = VersionResponse {
        version: entries.clone(),
        frontiers: entries.clone(),
        encoded_version: "AA==".into(),
        encoded_frontiers: "AQ==".into(),
    };
    assert_ne!(version.clone(), VersionResponse::default());
    assert_eq!(VersionRequest::default(), VersionRequest { handle: 0 });
    let fork = ForkRequest { handle: 1, peer: "9".into(), at: Some(entries) };
    assert_ne!(fork.clone(), ForkRequest::default());
    assert_eq!(UndoStateRequest::default(), UndoStateRequest { handle: 0 });
    assert_eq!(UndoClearRequest::default(), UndoClearRequest { handle: 0 });
    assert_eq!(
        UndoStateResponse::default(),
        UndoStateResponse { can_undo: false, can_redo: false }
    );
    let subtree =
        ImportSubtreeRequest { handle: 1, bytes: "AA==".into(), parent_path: Some("a/b".into()) };
    assert_ne!(subtree.clone(), ImportSubtreeRequest::default());
}
