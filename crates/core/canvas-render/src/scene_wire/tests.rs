use whiteboard_scene::{
    BoundingBox, EmbedPlaceholderNode, EmbedReason, LegendEntry, LegendKey, LegendKind,
    LegendSwatch, Scene, SceneLegend, SceneNode, Uncarried,
};

use super::{NonFinite, Tree, scene_tree};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn placeholder(x: f64, title: &str) -> SceneNode {
    SceneNode::EmbedPlaceholder(EmbedPlaceholderNode {
        bbox: BoundingBox { x, y: 1.5, w: 0.1, h: 1e21 },
        document_id: "d".to_owned(),
        title: title.to_owned(),
        reason: EmbedReason::DepthCap,
    })
}

#[test]
fn a_scene_is_written_as_the_typescript_object_with_every_double_read_back() {
    let scene = Scene { nodes: vec![placeholder(-0.0, "a \"b\" \\ \u{1}\u{1f}\n")], legend: None };
    let json = scene_tree(&scene).to_json();
    assert_eq!(
        json.as_deref(),
        Ok(concat!(
            r#"{"nodes":[{"kind":"embedPlaceholder","bbox":{"x":-0,"y":1.5,"w":0.1,"h":1e+21},"#,
            r#""documentId":"d","title":"a \"b\" \\ \u0001\u001f\u000a","reason":"depthCap"}]}"#
        ))
    );
}

#[test]
fn a_tree_holding_a_number_json_cannot_spell_has_no_text() {
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let scene = Scene { nodes: vec![placeholder(value, "t")], legend: None };
        assert_eq!(scene_tree(&scene).to_json(), Err(NonFinite));
    }
}

#[test]
fn a_legend_is_written_beside_the_nodes() {
    let key = |of| LegendKey {
        key: "k".to_owned(),
        of,
        entries: vec![LegendEntry {
            value: String::new(),
            count: 2.0,
            swatch: LegendSwatch { fill: Some("#fff".to_owned()), stroke: None },
        }],
    };
    let legend = SceneLegend {
        keys: vec![key(LegendKind::Boxes), key(LegendKind::Edges)],
        uncarried: Uncarried { boxes: true, edges: false },
    };
    let json = scene_tree(&Scene { nodes: Vec::new(), legend: Some(legend) }).to_json();
    let entry = r##"[{"value":"","count":2,"swatch":{"fill":"#fff"}}]"##;
    assert_eq!(
        json,
        Ok(format!(
            r#"{{"nodes":[],"legend":{{"keys":[{{"key":"k","of":"boxes","entries":{entry}}},{{"key":"k","of":"edges","entries":{entry}}}],"uncarried":{{"boxes":true,"edges":false}}}}}}"#
        ))
    );
}

#[test]
fn flags_and_lists_are_written_in_order() {
    let tree = Tree::List(vec![Tree::Flag(true), Tree::Flag(false), Tree::Object(Vec::new())]);
    assert_eq!(tree.to_json(), Ok("[true,false,{}]".to_owned()));
}
