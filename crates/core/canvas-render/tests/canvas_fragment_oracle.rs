//! `select_canvas_fragment` against the recorded TypeScript answers: for each
//! canvas and fragment, the ids of the nodes, edges and lines the selected
//! canvas keeps, or none (`canvas-fragment.jsonl`).

use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::canvas_fragment::select_canvas_fragment;
use whiteboard_model::spatial::{
    CanvasEdge, CanvasLine, EdgeEnd, NodeResource, SpatialCanvas, SpatialNode,
};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeWire {
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    label: Option<String>,
    /// Read for its presence alone: a node with none is a group.
    resource: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EndWire {
    node: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EdgeWire {
    id: String,
    from: EndWire,
    to: EndWire,
}

/// A line's ends are never read by the selection, which keeps every line.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LineWire {
    id: String,
    #[serde(rename = "from")]
    _from: Value,
    #[serde(rename = "to")]
    _to: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CanvasWire {
    nodes: Vec<NodeWire>,
    edges: Vec<EdgeWire>,
    lines: Option<Vec<LineWire>>,
}

#[derive(Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
struct Selected {
    nodes: Vec<String>,
    edges: Vec<String>,
    lines: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    canvas: CanvasWire,
    fragment: String,
    selected: Option<Selected>,
}

fn node_of(wire: &NodeWire) -> SpatialNode {
    let resource = wire.resource.as_ref().map(|_| NodeResource {
        mime_type: "text/markdown".to_owned(),
        content: Some(wire.id.clone()),
        ..NodeResource::default()
    });
    SpatialNode {
        id: wire.id.clone(),
        x: wire.x,
        y: wire.y,
        width: wire.width,
        height: wire.height,
        label: wire.label.clone(),
        resource,
        ..SpatialNode::default()
    }
}

fn canvas_of(wire: &CanvasWire) -> SpatialCanvas {
    let end = |end: &EndWire| EdgeEnd { node: end.node.clone(), ..EdgeEnd::default() };
    SpatialCanvas {
        nodes: wire.nodes.iter().map(node_of).collect(),
        edges: wire
            .edges
            .iter()
            .map(|e| CanvasEdge {
                id: e.id.clone(),
                from: end(&e.from),
                to: end(&e.to),
                ..CanvasEdge::default()
            })
            .collect(),
        lines: wire.lines.as_ref().map(|lines| {
            lines.iter().map(|l| CanvasLine { id: l.id.clone(), ..CanvasLine::default() }).collect()
        }),
        ..SpatialCanvas::default()
    }
}

/// The ids a selected canvas keeps, after checking it is the input narrowed
/// to them: every node, edge and line kept whole, everything else untouched.
fn selected_of(input: &SpatialCanvas, part: &SpatialCanvas) -> Result<Selected, String> {
    let mut narrowed = input.clone();
    narrowed.nodes.retain(|n| part.nodes.contains(n));
    narrowed.edges.retain(|e| part.edges.contains(e));
    if narrowed != *part {
        return Err("the selection is not the input narrowed".to_owned());
    }
    Ok(Selected {
        nodes: part.nodes.iter().map(|n| n.id.clone()).collect(),
        edges: part.edges.iter().map(|e| e.id.clone()).collect(),
        lines: part.lines.as_ref().map(|lines| lines.iter().map(|l| l.id.clone()).collect()),
    })
}

/// What differs for one record, or nothing.
fn replay(record: &Record) -> Result<(), String> {
    let canvas = canvas_of(&record.canvas);
    let got = select_canvas_fragment(&canvas, &record.fragment)
        .map(|part| selected_of(&canvas, &part))
        .transpose()
        .map_err(|e| format!("{}: {e}", record.id))?;
    if got == record.selected {
        return Ok(());
    }
    Err(format!("{}: selected {got:?}, recorded {:?}", record.id, record.selected))
}

#[test]
fn every_recorded_fragment_selects_what_the_typescript_selected() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/canvas-fragment.jsonl");
    let records: Vec<Record> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    assert!(records.len() > 500, "the recording holds {} records", records.len());
    let failures: Vec<String> = records.iter().filter_map(|r| replay(r).err()).collect();
    assert!(failures.is_empty(), "{} differ; first: {:?}", failures.len(), failures.first());
}
