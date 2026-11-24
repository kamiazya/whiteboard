//! `wb_viewport_set` over `whiteboard-ops`'s `ViewportSet`.

use serde_json::{Map, Value};
use whiteboard_model::checks::canonical_ulid;
use whiteboard_ops::{ViewportSet, ViewportSetAnswer};
use whiteboard_ports::{ViewportMode, ViewportRequest};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::{Field, Input, Kind, Refined};
use super::json::Json;

/// `CANVAS_MAX_NODES`: a longer list names ids no board holds.
const MAX_ELEMENTS: usize = 2000;

/// `MIN_VIEWPORT_ZOOM` and `MAX_VIEWPORT_ZOOM`, the editor's own range.
const ZOOM: (f64, f64) = (0.1, 10.0);

const BOTH_HALVES: &str = "elementIds (frame these) and scrollX, scrollY or zoom (go to this position) cannot be sent together — the browser would apply only one. Send one or the other.";
const FIT_POSITIONED: &str = "mode fit takes no scrollX, scrollY or zoom — it frames elementIds, or the whole board. Use mode move to go to a position.";
const MOVE_FRAMED: &str = "mode move takes no elementIds — it goes to scrollX, scrollY at zoom. Use mode fit to frame elements.";

impl Binding for ViewportSet {
    const NAME: &str = "wb_viewport_set";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_viewport_set.json");
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
            Field { name: "mode", kind: Kind::Choice(&["fit", "move"]) },
            Field {
                name: "elementIds",
                kind: Kind::Listed {
                    min: 0,
                    max: MAX_ELEMENTS,
                    too_big: None,
                    item: Refined {
                        test: |id| !id.is_empty(),
                        message: "node id must not be empty",
                    },
                },
            },
            Field {
                name: "scrollX",
                kind: Kind::Real { min: f64::NEG_INFINITY, max: f64::INFINITY },
            },
            Field {
                name: "scrollY",
                kind: Kind::Real { min: f64::NEG_INFINITY, max: f64::INFINITY },
            },
            Field { name: "zoom", kind: Kind::Real { min: ZOOM.0, max: ZOOM.1 } },
        ],
        refine: Some(halves),
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> ViewportRequest {
        let text = |key: &str| arguments.get(key).and_then(Value::as_str);
        let number = |key: &str| arguments.get(key).and_then(Value::as_f64);
        let mode = text("mode").map(|mode| match mode {
            "move" => ViewportMode::Move,
            _ => ViewportMode::Fit,
        });
        let element_ids = arguments
            .get("elementIds")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_owned).collect());
        ViewportRequest {
            workspace_id: workspace_id.unwrap_or_default(),
            document_id: text("documentId").unwrap_or_default().to_owned(),
            mode,
            element_ids,
            scroll_x: number("scrollX"),
            scroll_y: number("scrollY"),
            zoom: number("zoom"),
        }
    }

    fn output(answer: &ViewportSetAnswer) -> Option<Json> {
        let ViewportSetAnswer::Told { document_id, delivered } = answer else { return None };
        Some(Json::Object(vec![
            ("documentId", Json::Text(document_id.clone())),
            ("delivered", Json::Bool(*delivered)),
        ]))
    }
}

/// The schema's refinement: a page applies exactly one half of a request
/// (fit reads `elementIds`, move the position), so a call naming both, or
/// naming the half its mode drops, is refused rather than reported told.
fn halves(arguments: &Map<String, Value>) -> Option<&'static str> {
    let positioned = ["scrollX", "scrollY", "zoom"].iter().any(|key| arguments.contains_key(*key));
    let framed = arguments.contains_key("elementIds");
    let mode = arguments.get("mode").and_then(Value::as_str);
    if framed && positioned {
        Some(BOTH_HALVES)
    } else if mode == Some("fit") && positioned {
        Some(FIT_POSITIONED)
    } else if mode == Some("move") && framed {
        Some(MOVE_FRAMED)
    } else {
        None
    }
}
