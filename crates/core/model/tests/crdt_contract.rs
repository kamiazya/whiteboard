//! The generated CRDT document-engine contract, held against the schema it is
//! generated from: every enum value the schema lists must name a variant both
//! ways, so a value added to the contract is covered without a line here.

use whiteboard_model::Value;
use whiteboard_model::crdt::{
    Breach, BreachShape, CloseRequest, ExportRequest, ExportResponse, ExportShallowSnapshotRequest,
    ExportSnapshotRequest, ExportUpdateRequest, ImportRequest, MutationApplied, MutationRefused,
    MutationResult, OpenRequest, OpenResponse, Query, QueryName, ReadRequest, ReadResponse,
    RedoRequest, TextSpliceRequest, UndoRequest, VersionEntry, Write, WriteRequest, WriterName,
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

wire_enum_covered!(every_breach_shape_round_trips, BreachShape, 20);
wire_enum_covered!(every_query_name_round_trips, QueryName, 33);
wire_enum_covered!(every_writer_name_round_trips, WriterName, 47);

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
        index: u64::MAX,
        remove: 0,
        insert: "x".into(),
    };
    assert_eq!(splice.clone(), splice);
    assert_ne!(splice, TextSpliceRequest::default());
    assert_eq!(TextSpliceRequest::default().index, 0);

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
    let applied = MutationApplied { changed: vec!["d".into()], local_update: Some("AA==".into()) };
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
