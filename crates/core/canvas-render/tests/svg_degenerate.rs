//! What the SVG backend does with geometry that cannot be drawn, against the
//! TypeScript: a box with a non-finite field is dropped where the backend can
//! say nothing, a number that would reach the output refuses the render, and an
//! option that is not usable falls back to what the scene derives.
//!
//! A scene is JSON in the recordings, so a non-finite number cannot be written
//! there; these build the scene from JSON and set the field afterwards.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::svg::{
    NonFinite, SvgDocumentOptions, render_scene_to_keyed_svg, render_scene_to_svg,
};
use whiteboard_scene::{BoundingBox, Scene, SceneNode};

const ROOT: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\"";

fn scene(json: &str) -> Scene {
    let read = serde_json::from_str(json);
    assert!(read.is_ok(), "{read:?}: {json}");
    read.unwrap_or_default()
}

fn nodes(list: &str) -> Scene {
    scene(&format!(r#"{{"nodes":[{list}]}}"#))
}

fn bbox_of(node: &mut SceneNode) -> Option<&mut BoundingBox> {
    match node {
        SceneNode::Shape(n) => Some(&mut n.bbox),
        SceneNode::TextRun(n) => Some(&mut n.bbox),
        SceneNode::Glyph(n) => Some(&mut n.bbox),
        SceneNode::Image(n) => Some(&mut n.bbox),
        SceneNode::Icon(n) => Some(&mut n.bbox),
        SceneNode::SvgFragment(n) => Some(&mut n.bbox),
        SceneNode::ThematicBreak(n) => Some(&mut n.bbox),
        SceneNode::CodeBlock(n) => Some(&mut n.bbox),
        _ => None,
    }
}

/// The scene with the first node's box field set to `value`.
fn broken(mut scene: Scene, field: fn(&mut BoundingBox) -> &mut f64, value: f64) -> Scene {
    if let Some(node) = scene.nodes.first_mut()
        && let Some(bbox) = bbox_of(node)
    {
        *field(bbox) = value;
    }
    scene
}

fn x(b: &mut BoundingBox) -> &mut f64 {
    &mut b.x
}

fn y(b: &mut BoundingBox) -> &mut f64 {
    &mut b.y
}

fn w(b: &mut BoundingBox) -> &mut f64 {
    &mut b.w
}

fn drawn(scene: &Scene, options: Option<&SvgDocumentOptions>) -> String {
    render_scene_to_svg(scene, options).unwrap_or_else(|e| format!("REFUSED {e:?}"))
}

fn refused(scene: &Scene) -> bool {
    matches!(render_scene_to_svg(scene, None), Err(NonFinite(_)))
        && matches!(render_scene_to_keyed_svg(scene, None), Err(NonFinite(_)))
}

const BOX: &str = r#""bbox":{"x":0,"y":0,"w":40,"h":16}"#;

#[test]
fn a_box_with_a_non_finite_field_draws_nothing_where_it_can_say_nothing() {
    let nothing = format!("{ROOT}></svg>");
    let shape = format!(r#"{{"kind":"shape",{BOX}}}"#);
    assert_eq!(drawn(&broken(nodes(&shape), x, f64::NAN), None), nothing);
    assert_eq!(drawn(&broken(nodes(&shape), w, f64::INFINITY), None), nothing);
    let glyph = format!(r#"{{"kind":"glyph",{BOX},"glyph":"g"}}"#);
    assert_eq!(drawn(&broken(nodes(&glyph), x, f64::NAN), None), nothing);
    let icon = format!(r#"{{"kind":"icon","icon":"star",{BOX}}}"#);
    assert_eq!(drawn(&broken(nodes(&icon), x, f64::NAN), None), nothing);
    let code = format!(
        r##"{{"kind":"codeBlock",{BOX},"value":"v","appearance":{{"fill":"#eee"}},"runs":[]}}"##
    );
    assert_eq!(drawn(&broken(nodes(&code), y, f64::NAN), None), format!("{ROOT}></svg>"));
}

#[test]
fn a_non_finite_number_that_would_be_written_refuses_the_whole_render() {
    let run = format!(r#"{{"kind":"textRun",{BOX},"text":"a"}}"#);
    assert!(refused(&broken(nodes(&run), x, f64::NAN)));
    let image = format!(r#"{{"kind":"image",{BOX},"href":"x"}}"#);
    assert!(refused(&broken(nodes(&image), x, f64::NAN)));
    let rule = format!(r#"{{"kind":"thematicBreak",{BOX}}}"#);
    assert!(refused(&broken(nodes(&rule), x, f64::NAN)));
    let haloed =
        format!(r##"{{"kind":"textRun",{BOX},"text":"a","appearance":{{"halo":"#fff"}}}}"##);
    assert!(refused(&broken(nodes(&haloed), w, f64::NAN)));
    let edge = r#"{"kind":"edge","id":"e","path":[{"x":0,"y":0},{"x":1,"y":1}],"fromSide":"left","toSide":"right","fromEnd":"none","toEnd":"none"}"#;
    let mut bent = nodes(edge);
    if let Some(SceneNode::Edge(e)) = bent.nodes.first_mut()
        && let Some(point) = e.path.get_mut(1)
    {
        point.x = f64::NAN;
    }
    assert!(refused(&bent));
    if let Some(SceneNode::Edge(e)) = bent.nodes.first_mut()
        && let Some(point) = e.path.get_mut(1)
    {
        point.x = f64::INFINITY;
    }
    assert!(refused(&bent));
}

#[test]
fn a_run_whose_width_is_unusable_still_draws_its_text_and_loses_its_backdrop() {
    let run = r##"{"kind":"textRun","bbox":{"x":1,"y":2,"w":9,"h":10},"text":"a","backdrop":{"fill":"#eee"}}"##;
    let got = drawn(&broken(nodes(run), w, f64::NAN), None);
    assert_eq!(got, format!("{ROOT}><text x=\"1\" y=\"2\">a</text></svg>"));
}

#[test]
fn a_baseline_that_is_not_finite_is_omitted_and_the_run_sits_at_its_top() {
    for baseline in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut s = nodes(r#"{"kind":"textRun","bbox":{"x":1,"y":2,"w":9,"h":10},"text":"a"}"#);
        if let Some(SceneNode::TextRun(run)) = s.nodes.first_mut() {
            run.baseline = Some(baseline);
        }
        assert_eq!(drawn(&s, None), format!("{ROOT}><text x=\"1\" y=\"2\">a</text></svg>"));
    }
}

#[test]
fn a_fragment_with_an_unusable_box_is_an_unpositioned_group() {
    let a = format!(r#"{{"kind":"svgFragment",{BOX},"svg":"<a/>","role":"presentation"}}"#);
    let b = format!(r#"{{"kind":"svgFragment",{BOX},"svg":"<b/>"}}"#);
    let mut both = nodes(&format!("{a},{b}"));
    if let Some(SceneNode::SvgFragment(n)) = both.nodes.first_mut() {
        n.bbox.x = f64::NAN;
    }
    if let Some(SceneNode::SvgFragment(n)) = both.nodes.get_mut(1) {
        n.bbox.y = f64::NAN;
    }
    assert_eq!(
        drawn(&both, None),
        format!("{ROOT}><g role=\"presentation\"><a/></g><g><b/></g></svg>")
    );
}

#[test]
fn a_table_row_with_an_unusable_box_draws_no_separator() {
    let row = format!(
        r##"{{"kind":"table",{BOX},"rows":[{{"kind":"tableRow",{BOX},"cells":[],"appearance":{{"stroke":"#000"}}}}]}}"##
    );
    let mut s = nodes(&row);
    if let Some(SceneNode::Table(t)) = s.nodes.first_mut()
        && let Some(r) = t.rows.first_mut()
    {
        r.bbox.y = f64::NAN;
    }
    assert_eq!(drawn(&s, None), format!("{ROOT}><g><g></g></g></svg>"));
}

#[test]
fn a_list_item_shifts_by_its_x_unless_that_x_is_zero_and_refuses_when_it_is_not_a_number() {
    let item = |x: &str| {
        format!(r#"{{"kind":"listItem","bbox":{{"x":{x},"y":0,"w":1,"h":1}},"children":[]}}"#)
    };
    let list = format!(
        r#"{{"kind":"list",{BOX},"ordered":false,"depth":0,"items":[{},{}]}}"#,
        item("-0.0"),
        item("0.0004")
    );
    assert_eq!(
        drawn(&nodes(&list), None),
        format!("{ROOT}><g><g></g><g transform=\"translate(0,0)\"></g></g></svg>")
    );
    let mut s = nodes(&list);
    if let Some(SceneNode::List(l)) = s.nodes.first_mut()
        && let Some(i) = l.items.first_mut()
    {
        i.bbox.x = f64::NAN;
    }
    assert!(refused(&s));
}

fn square() -> Scene {
    nodes(r#"{"kind":"shape","bbox":{"x":0,"y":0,"w":10,"h":10}}"#)
}

#[test]
fn an_option_that_is_not_usable_falls_back_to_what_the_scene_derives() {
    let derived = format!(
        "{ROOT} width=\"10\" height=\"10\" viewBox=\"0 0 10 10\"><rect x=\"0\" y=\"0\" width=\"10\" height=\"10\"/></svg>"
    );
    let box_with = |x: f64, w: f64| BoundingBox { x, y: 0.0, w, h: 10.0 };
    let options = |o: SvgDocumentOptions| drawn(&square(), Some(&o));
    let base = SvgDocumentOptions::default;
    assert_eq!(
        options(SvgDocumentOptions { view_box: Some(box_with(f64::NAN, 10.0)), ..base() }),
        derived
    );
    assert_eq!(
        options(SvgDocumentOptions { view_box: Some(box_with(0.0, -1.0)), ..base() }),
        derived
    );
    assert_eq!(
        options(SvgDocumentOptions {
            width: Some(f64::NAN),
            height: Some(f64::INFINITY),
            padding: Some(f64::NAN),
            ..base()
        }),
        derived
    );
    assert_eq!(options(SvgDocumentOptions { padding: Some(f64::INFINITY), ..base() }), derived);
    assert_eq!(options(SvgDocumentOptions { padding: Some(-3.0), ..base() }), derived);
    assert_eq!(options(SvgDocumentOptions { width: Some(-1.0), ..base() }), derived);
}

#[test]
fn a_glow_radius_or_raster_scale_that_is_not_a_number_changes_nothing() {
    let rect = format!("{ROOT}><rect x=\"0\" y=\"0\" width=\"10\" height=\"10\"/></svg>");
    for radius in [f64::NAN, f64::INFINITY] {
        let mut s = nodes(
            r#"{"kind":"shape","bbox":{"x":0,"y":0,"w":10,"h":10},"appearance":{"glow":{"radiusPx":1}}}"#,
        );
        if let Some(SceneNode::Shape(n)) = s.nodes.first_mut()
            && let Some(a) = n.appearance.as_mut()
            && let Some(g) = a.glow.as_mut()
        {
            g.radius_px = radius;
        }
        let o =
            SvgDocumentOptions { raster_scale: Some(f64::NAN), ..SvgDocumentOptions::default() };
        // The raster scale is not an envelope option, so the root stays bare.
        assert_eq!(drawn(&s, Some(&o)), rect);
        assert_eq!(drawn(&s, None), rect);
    }
}

#[test]
fn an_empty_scene_has_no_groups_and_a_background_alone_is_the_one_pseudo_group() {
    let empty = Scene::default();
    let keyed = render_scene_to_keyed_svg(&empty, None);
    assert_eq!(keyed.as_ref().map(|k| k.groups.len()).ok(), Some(0));
    assert_eq!(keyed.map(|k| k.svg).ok().as_deref(), Some(format!("{ROOT}></svg>").as_str()));
    let options = SvgDocumentOptions {
        background: Some("#fff".into()),
        width: Some(5.0),
        ..SvgDocumentOptions::default()
    };
    let keyed = render_scene_to_keyed_svg(&empty, Some(&options));
    let group =
        keyed.as_ref().ok().and_then(|k| k.groups.first().map(|g| (g.key.as_str(), g.annotation)));
    assert_eq!(group, Some(("#background", false)));
    assert_eq!(
        keyed.map(|k| k.svg).ok(),
        Some(format!(
            "{ROOT} width=\"5\" height=\"1\" viewBox=\"0 0 1 1\"><rect x=\"0\" y=\"0\" width=\"1\" height=\"1\" fill=\"#fff\" role=\"presentation\"/></svg>"
        ))
    );
}
