//! The records of `compose-node.jsonl` that are not a node composed: the
//! decorations drawn over a node from the stencil and symbol it wears, and a
//! scene fitted into a box.

use serde::Deserialize;
use whiteboard_canvas_render::compose_node::compose_decorations;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::{NodeBoxHost, NodeBoxOptions, TextPlacement};
use whiteboard_canvas_render::scale_scene::fit_scene_into_box;
use whiteboard_canvas_render::theme::geometry::SPATIAL_THEME_GEOMETRY;
use whiteboard_canvas_render::typeset::EmbedBox;
use whiteboard_model::spatial::SpatialNode;
use whiteboard_plugin_visual::render::{NodeMarks, StencilBadge};
use whiteboard_plugin_visual::visual::{VisualSymbolEmoji, VisualSymbolFacet, VisualSymbolIcon};
use whiteboard_scene::SceneNode;

use super::{Context, Res, appearance_of, differ, dump_nodes, f64_of};

/// A symbol as the TypeScript's reader answers it.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum SymbolWire {
    Icon { name: String },
    Emoji { char: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BoxWire {
    id: String,
    #[serde(rename = "box")]
    bbox: [String; 4],
}

/// The decorations drawn over a node, from the stencil and symbol it wears.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Decoration {
    pub(super) id: String,
    node: BoxWire,
    theme: String,
    stencil: Option<String>,
    symbol: Option<SymbolWire>,
    scene: String,
}

impl NodeMarks for Decoration {
    fn stencil(&self, node: &SpatialNode) -> Option<String> {
        self.stencil.clone().filter(|_| node.id == self.node.id)
    }

    fn symbol(&self, node: &SpatialNode) -> Option<VisualSymbolFacet> {
        let symbol = self.symbol.as_ref().filter(|_| node.id == self.node.id)?;
        Some(match symbol {
            SymbolWire::Icon { name } => {
                VisualSymbolFacet::VisualSymbolIcon(VisualSymbolIcon { name: name.clone() })
            }
            SymbolWire::Emoji { char } => {
                VisualSymbolFacet::VisualSymbolEmoji(VisualSymbolEmoji { char: char.clone() })
            }
        })
    }
}

/// The recorder tells the decoration the node's own box, which an unshaped node
/// laid out without a fit is told too.
struct Unshaped;

impl NodeBoxHost for Unshaped {
    fn silhouette(&self, _: &str) -> Option<&str> {
        None
    }

    fn text_placement(&self, _: &SpatialNode) -> Option<TextPlacement> {
        None
    }
}

pub(super) fn replay_decoration(context: &Context, decoration: &Decoration) -> Res<()> {
    let [x, y, w, h] = &decoration.node.bbox;
    let node = SpatialNode {
        id: decoration.node.id.clone(),
        x: f64_of(x)?,
        y: f64_of(y)?,
        width: f64_of(w)?,
        height: f64_of(h)?,
        ..SpatialNode::default()
    };
    let appearance = appearance_of(context, &decoration.theme);
    let measure = FakeMeasure::default();
    let options = NodeBoxOptions {
        measure: &measure,
        appearance: appearance.as_ref(),
        geometry: SPATIAL_THEME_GEOMETRY,
        fit_to_box: false,
        theme: None,
        host: &Unshaped,
    };
    let badge = StencilBadge { marks: decoration };
    let scene = dump_nodes(compose_decorations(&node, &options, &[&badge]))?;
    if scene == decoration.scene {
        Ok(())
    } else {
        Err(format!("decorations: got\n{scene}\nrecorded\n{}", decoration.scene))
    }
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct FitAnswer {
    scene: String,
    w: String,
    h: String,
}

/// A scene fitted into a box, and what the fit answers.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Fit {
    pub(super) id: String,
    scene: Vec<SceneNode>,
    /// `[x, y, maxWidth, maxHeight]`.
    #[serde(rename = "box")]
    space: [String; 4],
    answer: Option<FitAnswer>,
}

pub(super) fn replay_fit(fit: &Fit) -> Res<()> {
    let [x, y, max_width, max_height] = &fit.space;
    let space = EmbedBox {
        x: f64_of(x)?,
        y: f64_of(y)?,
        max_width: f64_of(max_width)?,
        max_height: f64_of(max_height)?,
    };
    let hex = |value: f64| format!("{:016x}", value.to_bits());
    let got = match fit_scene_into_box(&fit.scene, &space) {
        None => None,
        Some(m) => Some(FitAnswer { scene: dump_nodes(m.nodes)?, w: hex(m.w), h: hex(m.h) }),
    };
    differ("fit", &got, &fit.answer)
}
