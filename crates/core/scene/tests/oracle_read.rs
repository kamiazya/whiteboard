//! A scene as the TypeScript records it reads into these types, and a scene
//! the vocabulary does not know is refused rather than half-read.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::spatial::EdgeSide;
use whiteboard_scene::{
    EdgeEnd, ImageFit, LinkProvenance, RunPaint, Scene, SceneInkFill, SceneNode,
};

fn scene(json: &str) -> Result<Scene, serde_json::Error> {
    serde_json::from_str(json)
}

const BOX: &str = r#"{"x":1,"y":2,"w":3,"h":4}"#;

#[test]
fn an_empty_scene_has_no_nodes_and_no_legend() {
    let read = scene(r#"{"nodes":[]}"#);
    assert_eq!(read.ok(), Some(Scene::default()));
}

#[test]
fn a_text_run_reads_its_flags_link_and_paint() {
    let json = format!(
        r##"{{"nodes":[{{"kind":"textRun","bbox":{BOX},"text":"t","strong":true,"truncated":true,
        "link":{{"kind":"wikiLink","documentId":"d","alias":"a"}},
        "paints":{{"kind":"icon","name":"star"}},"backdropPadXPx":2,"baseline":3.5,
        "annotates":{{"kind":"edge","id":"e"}},"appearance":{{"fill":"#fff","dropShadow":true,"glow":{{"radiusPx":4}}}}}}]}}"##
    );
    let Some(SceneNode::TextRun(run)) = scene(&json).ok().and_then(|s| s.nodes.into_iter().next())
    else {
        panic!("not a text run");
    };
    assert!(run.strong && run.truncated && !run.emphasis && !run.code && !run.deleted);
    assert!(!run.overflows);
    assert_eq!(
        run.link,
        Some(LinkProvenance::WikiLink {
            document_id: "d".into(),
            alias: Some("a".into()),
            fragment: None
        })
    );
    assert_eq!(run.paints, Some(RunPaint::Icon { name: "star".into() }));
    assert_eq!(run.backdrop_pad_x_px, Some(2.0));
    assert_eq!(run.baseline, Some(3.5));
    let appearance = run.appearance.unwrap_or_default();
    assert!(appearance.drop_shadow);
    assert_eq!(appearance.glow.map(|g| g.radius_px), Some(4.0));
}

#[test]
fn an_edge_reads_its_sides_ends_jumps_and_ink() {
    let json = r#"{"nodes":[{"kind":"edge","id":"e","path":[{"x":0,"y":0},{"x":9,"y":0}],
        "jumps":[{"segment":0,"x":4,"y":0}],"fromSide":"left","toSide":"bottom",
        "fromEnd":"none","toEnd":"arrow","rounded":true,
        "ink":{"style":"sketch","seed":7,"fill":"hatch"}}]}"#;
    let Some(SceneNode::Edge(edge)) = scene(json).ok().and_then(|s| s.nodes.into_iter().next())
    else {
        panic!("not an edge");
    };
    assert_eq!((edge.from_side, edge.to_side), (EdgeSide::Left, EdgeSide::Bottom));
    assert_eq!((edge.from_end, edge.to_end), (EdgeEnd::None, EdgeEnd::Arrow));
    assert!(edge.rounded && !edge.comment_chrome);
    assert_eq!(edge.jumps.map(|j| j.len()), Some(1));
    let ink = edge.ink;
    assert_eq!(ink.map(|i| (i.seed, i.fill)), Some((7, Some(SceneInkFill::Hatch))));
}

#[test]
fn a_nested_scene_reads_every_container_kind() {
    let json = format!(
        r#"{{"nodes":[
        {{"kind":"list","bbox":{BOX},"ordered":false,"depth":0,"items":[
          {{"kind":"listItem","bbox":{BOX},"ordinal":1,"checked":false,"children":[
            {{"kind":"image","bbox":{BOX},"href":"h","fit":"cover"}}]}}]}},
        {{"kind":"table","bbox":{BOX},"rows":[{{"kind":"tableRow","bbox":{BOX},"header":true,"cells":[
          {{"kind":"tableCell","bbox":{BOX},"runs":[]}}]}}]}}]}}"#
    );
    let parsed = scene(&json);
    assert!(parsed.is_ok(), "{parsed:?}");
    let Some(SceneNode::List(list)) = parsed.ok().and_then(|s| s.nodes.into_iter().next()) else {
        panic!("not a list");
    };
    let item = list.items.into_iter().next();
    let Some(SceneNode::Image(image)) = item.and_then(|i| i.children.into_iter().next()) else {
        panic!("not an image");
    };
    assert_eq!(image.fit, Some(ImageFit::Cover));
}

#[test]
fn a_field_the_vocabulary_lacks_is_refused() {
    let json =
        format!(r#"{{"nodes":[{{"kind":"glyph","bbox":{BOX},"glyph":"g","color":"red"}}]}}"#);
    assert!(scene(&json).is_err());
    assert!(scene(r#"{"nodes":[{"kind":"blob","bbox":{"x":0,"y":0,"w":0,"h":0}}]}"#).is_err());
}

#[test]
fn an_edge_side_the_model_does_not_name_is_refused() {
    let json = r#"{"nodes":[{"kind":"edge","id":"e","path":[],"fromSide":"Top","toSide":"top",
        "fromEnd":"none","toEnd":"none"}]}"#;
    assert!(scene(json).is_err());
}

#[test]
fn a_list_of_runs_items_rows_or_cells_is_read_by_its_kind_and_refuses_another() {
    let box_ = BOX;
    let cases = [
        // A paragraph's run must be a text run.
        format!(
            r#"{{"nodes":[{{"kind":"paragraph","bbox":{box_},"runs":[{{"kind":"glyph","bbox":{box_},"glyph":"g"}}]}}]}}"#
        ),
        // A run with no kind at all.
        format!(
            r#"{{"nodes":[{{"kind":"paragraph","bbox":{box_},"runs":[{{"bbox":{box_},"text":"t"}}]}}]}}"#
        ),
        // A run carrying a field the vocabulary lacks.
        format!(
            r#"{{"nodes":[{{"kind":"heading","bbox":{box_},"level":1,"runs":[{{"kind":"textRun","bbox":{box_},"text":"t","color":"red"}}]}}]}}"#
        ),
        // A list's item must be a list item.
        format!(
            r#"{{"nodes":[{{"kind":"list","bbox":{box_},"ordered":true,"depth":0,"items":[{{"kind":"tableRow","bbox":{box_},"cells":[]}}]}}]}}"#
        ),
        // A table's row must be a table row, and a row's cell a table cell.
        format!(
            r#"{{"nodes":[{{"kind":"table","bbox":{box_},"rows":[{{"kind":"tableCell","bbox":{box_},"runs":[]}}]}}]}}"#
        ),
        format!(
            r#"{{"nodes":[{{"kind":"table","bbox":{box_},"rows":[{{"kind":"tableRow","bbox":{box_},"cells":[{{"kind":"tableRow","bbox":{box_},"cells":[]}}]}}]}}]}}"#
        ),
        // A fenced block's runs, when present, are text runs too.
        format!(
            r#"{{"nodes":[{{"kind":"codeBlock","bbox":{box_},"value":"v","runs":[{{"kind":"glyph","bbox":{box_},"glyph":"g"}}]}}]}}"#
        ),
    ];
    for json in cases {
        assert!(scene(&json).is_err(), "{json}");
    }
}

#[test]
fn a_fenced_block_has_runs_absent_null_or_listed() {
    let absent = format!(r#"{{"nodes":[{{"kind":"codeBlock","bbox":{BOX},"value":"v"}}]}}"#);
    let null =
        format!(r#"{{"nodes":[{{"kind":"codeBlock","bbox":{BOX},"value":"v","runs":null}}]}}"#);
    let listed = format!(
        r#"{{"nodes":[{{"kind":"codeBlock","bbox":{BOX},"value":"v","runs":[{{"kind":"textRun","bbox":{BOX},"text":"t"}}]}}]}}"#
    );
    let runs = |json: &str| match scene(json).ok().and_then(|s| s.nodes.into_iter().next()) {
        Some(SceneNode::CodeBlock(code)) => Some(code.runs.map(|r| r.len())),
        _ => None,
    };
    assert_eq!(runs(&absent), Some(None));
    assert_eq!(runs(&null), Some(None));
    assert_eq!(runs(&listed), Some(Some(1)));
}
