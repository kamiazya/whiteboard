//! `wb_canvas_snapshot` over `whiteboard-ops`'s `CanvasSnapshot`.

use serde_json::{Map, Value};
use whiteboard_model::checks::canonical_ulid;
use whiteboard_ops::{
    CanvasSnapshot, CanvasSnapshotAnswer, CanvasSnapshotInput, CanvasSnapshotOutput, Shown,
    SnapshotEdge, SnapshotLine, SnapshotNode,
};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::{Field, Input, Kind, Refined};
use super::json::Json;

impl Binding for CanvasSnapshot {
    const NAME: &str = "wb_canvas_snapshot";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_canvas_snapshot.json");
    const INPUT: Input = Input {
        fields: &[
            WORKSPACE_ADDRESS,
            Field {
                name: "documentId",
                kind: Kind::Text(Refined {
                    test: canonical_ulid,
                    message: "must be a canonical ULID",
                }),
            },
            Field { name: "layout", kind: Kind::Flag },
        ],
        refine: None,
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> CanvasSnapshotInput {
        CanvasSnapshotInput {
            workspace_id: workspace_id.unwrap_or_default(),
            document_id: arguments
                .get("documentId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            layout: arguments.get("layout").and_then(Value::as_bool).unwrap_or(false),
        }
    }

    fn output(answer: &CanvasSnapshotAnswer) -> Option<Json> {
        let CanvasSnapshotAnswer::Snapshot(snapshot) = answer else { return None };
        Some(snapshot_json(snapshot))
    }
}

/// The snapshot in the order the TypeScript builds it.
fn snapshot_json(snapshot: &CanvasSnapshotOutput) -> Json {
    let count = |n: usize| Json::Number(f64::from(u32::try_from(n).unwrap_or(u32::MAX)));
    Json::Object(vec![
        ("documentId", Json::Text(snapshot.document_id.clone())),
        ("nodes", Json::List(snapshot.nodes.iter().map(node_json).collect())),
        ("edges", Json::List(snapshot.edges.iter().map(edge_json).collect())),
        ("lines", Json::List(snapshot.lines.iter().map(line_json).collect())),
        ("nodeCount", count(snapshot.node_count)),
        ("edgeCount", count(snapshot.edge_count)),
        ("lineCount", count(snapshot.line_count)),
        ("truncated", Json::Bool(snapshot.truncated)),
    ])
}

/// A member copied as it stands, when the element holds it.
fn copied(
    members: &mut Vec<(&'static str, Json)>,
    key: &'static str,
    value: Option<&whiteboard_model::Value>,
) {
    if let Some(value) = value {
        members.push((key, Json::Plain(value.clone())));
    }
}

/// `locked: true`, absent when not: absent means no.
fn lock(members: &mut Vec<(&'static str, Json)>, locked: bool) {
    if locked {
        members.push(("locked", Json::Bool(true)));
    }
}

/// The base every node carries, then what it shows.
fn node_json(node: &SnapshotNode) -> Json {
    let mut members = vec![
        ("id", Json::Text(node.id.clone())),
        ("type", Json::Text(node.kind.to_owned())),
        ("x", Json::Number(node.x)),
        ("y", Json::Number(node.y)),
        ("width", Json::Number(node.width)),
        ("height", Json::Number(node.height)),
    ];
    copied(&mut members, "color", node.color.as_ref());
    lock(&mut members, node.locked);
    copied(&mut members, "facets", node.facets.as_ref());
    copied(&mut members, "tags", node.tags.as_ref());
    match &node.shown {
        Some(Shown::Text { text, truncated }) => {
            members.push(("text", Json::Text(text.clone())));
            if *truncated {
                members.push(("textTruncated", Json::Bool(true)));
            }
        }
        Some(Shown::Label(label)) => members.push(("label", Json::Text(label.clone()))),
        Some(Shown::File(file)) => members.push(("file", Json::Text(file.clone()))),
        Some(Shown::Url(url)) => members.push(("url", Json::Text(url.clone()))),
        None => {}
    }
    Json::Object(members)
}

fn edge_json(edge: &SnapshotEdge) -> Json {
    let mut members = vec![
        ("id", Json::Text(edge.id.clone())),
        ("from", Json::Plain(edge.from.clone())),
        ("to", Json::Plain(edge.to.clone())),
    ];
    copied(&mut members, "label", edge.label.as_ref());
    copied(&mut members, "color", edge.color.as_ref());
    lock(&mut members, edge.locked);
    copied(&mut members, "bends", edge.bends.as_ref());
    copied(&mut members, "facets", edge.facets.as_ref());
    copied(&mut members, "tags", edge.tags.as_ref());
    Json::Object(members)
}

fn line_json(line: &SnapshotLine) -> Json {
    let mut members = vec![
        ("id", Json::Text(line.id.clone())),
        ("from", Json::Plain(line.from.clone())),
        ("to", Json::Plain(line.to.clone())),
    ];
    copied(&mut members, "label", line.label.as_ref());
    copied(&mut members, "color", line.color.as_ref());
    copied(&mut members, "bends", line.bends.as_ref());
    copied(&mut members, "facets", line.facets.as_ref());
    Json::Object(members)
}
