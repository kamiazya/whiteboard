//! The typesetter's rules, one example each, in numbers a reader can check by
//! hand: the fake measurer charges 9.6px a character at the node theme's 16px
//! body, and a line box is 24.8px.

#[path = "typeset_support/examples.rs"]
mod examples;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::theme::markdown::MarkdownTheme;
use whiteboard_canvas_render::typeset::{IconRange, ImageRef, Unsupported};
use whiteboard_model::mdast::{Flow, Phrasing};
use whiteboard_scene::{LinkProvenance, RunPaint, Scene, SceneNode, TextRunNode};

use examples::*;

fn runs_of(scene: &Scene) -> Vec<&TextRunNode> {
    scene
        .nodes
        .iter()
        .flat_map(|node| match node {
            SceneNode::Paragraph(p) => p.runs.iter().collect::<Vec<_>>(),
            SceneNode::Heading(h) => h.runs.iter().collect(),
            _ => Vec::new(),
        })
        .collect()
}

#[test]
fn a_paragraph_that_is_an_embed_is_not_yet_carried() {
    let embed = Phrasing::Embed { document_id: "x".to_owned(), fragment: None };
    assert_eq!(laid(100.0, vec![paragraph(vec![embed])]).err(), Some(Unsupported("embed")));
}

#[test]
fn text_that_fits_is_one_run_at_the_origin() {
    let scene = laid(1000.0, vec![paragraph(vec![text("ab cd")])]).unwrap_or_default();
    let runs = runs_of(&scene);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].text, "ab cd");
    assert_eq!((runs[0].bbox.x, runs[0].bbox.y, runs[0].bbox.h), (0.0, 0.0, LINE));
    assert!((runs[0].bbox.w - 48.0).abs() < 1e-9);
}

#[test]
fn text_that_does_not_fit_wraps_at_a_space_one_run_a_line() {
    let scene = laid(60.0, vec![paragraph(vec![text("aaaa bbbb")])]).unwrap_or_default();
    let runs = runs_of(&scene);
    assert_eq!(runs.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), ["aaaa", "bbbb"]);
    assert_eq!((runs[0].bbox.y, runs[1].bbox.y), (0.0, LINE));
    same(runs[1].bbox.x, 0.0);
    let SceneNode::Paragraph(block) = &scene.nodes[0] else { return };
    same(block.bbox.h, 2.0 * LINE);
}

#[test]
fn a_hard_break_starts_a_line_whatever_the_width() {
    let children = vec![text("a"), Phrasing::Break, text("b")];
    let scene = laid(1000.0, vec![paragraph(children)]).unwrap_or_default();
    let runs = runs_of(&scene);
    assert_eq!((runs[0].bbox.y, runs[1].bbox.y), (0.0, LINE));
}

#[test]
fn a_closing_character_does_not_open_a_line_after_inline_code() {
    let children = vec![
        text("これは日本語です"),
        Phrasing::InlineCode { value: "layout".to_owned() },
        text("。つづき"),
    ];
    let scene = laid(150.0, vec![paragraph(children)]).unwrap_or_default();
    for run in runs_of(&scene).iter().filter(|r| r.bbox.x == 0.0) {
        assert!(!run.text.starts_with('。'), "{}", run.text);
    }
}

#[test]
fn inline_code_is_atomic_padded_in_flow_and_cut_to_the_width() {
    let code = Phrasing::InlineCode { value: "x".repeat(60) };
    let scene = laid(100.0, vec![paragraph(vec![code])]).unwrap_or_default();
    let run = runs_of(&scene)[0];
    assert!(run.code && run.truncated && !run.overflows);
    assert_eq!(run.backdrop_pad_x_px, Some(5.0));
    same(run.bbox.x, 5.0);
    assert!(run.bbox.w + 10.0 <= 100.0);
}

#[test]
fn inline_math_overflows_instead_of_being_cut() {
    let math = Phrasing::InlineMath { value: "x".repeat(60) };
    let scene = laid(100.0, vec![paragraph(vec![math])]).unwrap_or_default();
    let run = runs_of(&scene)[0];
    assert!(!run.truncated && run.bbox.w > 100.0);
    let SceneNode::Paragraph(block) = &scene.nodes[0] else { return };
    same(block.bbox.w, run.bbox.x + run.bbox.w);
}

#[test]
fn a_link_stamps_its_address_on_every_run_it_holds() {
    let inner = Phrasing::Strong { children: vec![text("bold")] };
    let link = Phrasing::Link {
        url: "https://e.com".to_owned(),
        title: Some("T".to_owned()),
        children: vec![text("see "), inner],
    };
    let scene = laid(1000.0, vec![paragraph(vec![link])]).unwrap_or_default();
    let want =
        LinkProvenance::Link { href: "https://e.com".to_owned(), title: Some("T".to_owned()) };
    let runs = runs_of(&scene);
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().all(|r| r.link.as_ref() == Some(&want)));
    assert!(runs[1].strong && !runs[0].strong);
}

#[test]
fn a_wiki_link_reads_as_its_alias_else_its_id_with_the_fragment() {
    let plain = Phrasing::WikiLink {
        document_id: "01ID".to_owned(),
        alias: None,
        fragment: Some("Part".to_owned()),
    };
    let aliased = Phrasing::WikiLink {
        document_id: "01ID".to_owned(),
        alias: Some("shown".to_owned()),
        fragment: None,
    };
    let scene = laid(1000.0, vec![paragraph(vec![plain, text(" "), aliased])]).unwrap_or_default();
    let texts: Vec<&str> = runs_of(&scene).iter().map(|r| r.text.as_str()).collect();
    assert_eq!(texts, ["01ID › Part", "shown"]);
}

#[test]
fn a_picture_with_nowhere_to_load_from_reads_as_its_alt() {
    let relative =
        Phrasing::Image { url: "pics/a.png".to_owned(), title: None, alt: Some("alt".to_owned()) };
    let remote = Phrasing::Image { url: "HTTPS://e.com/a.png".to_owned(), title: None, alt: None };
    let scene =
        laid(1000.0, vec![paragraph(vec![relative, text(" "), remote])]).unwrap_or_default();
    let runs = runs_of(&scene);
    assert_eq!(runs[0].text, "alt");
    assert!(runs[0].paints.is_none());
    assert_eq!(runs[1].text, "\u{2002}");
    assert_eq!(runs[1].paints, Some(RunPaint::Image { src: "HTTPS://e.com/a.png".to_owned() }));
}

#[test]
fn a_heading_takes_space_above_unless_it_leads() {
    let h = |depth| Flow::Heading { depth, children: vec![text("T")] };
    let scene = laid(1000.0, vec![h(1), h(2)]).unwrap_or_default();
    let (SceneNode::Heading(first), SceneNode::Heading(second)) =
        (&scene.nodes[0], &scene.nodes[1])
    else {
        return;
    };
    same(first.bbox.y, 0.0);
    assert_eq!(first.level, 1);
    same(first.bbox.h, 24.0 * 1.25);
    same(second.bbox.y, first.bbox.h + 12.0 + 18.0);
    same(second.bbox.h, 20.0 * 1.25);
}

#[test]
fn a_non_finite_width_turns_wrapping_off() {
    let long = "word ".repeat(40);
    let scene = laid(f64::INFINITY, vec![paragraph(vec![text(&long)])]).unwrap_or_default();
    assert_eq!(runs_of(&scene).len(), 1);
    let SceneNode::Paragraph(block) = &scene.nodes[0] else { return };
    same(block.bbox.w, f64::INFINITY);
}

fn icon(from: usize, to: usize) -> IconRange {
    IconRange { from, to, name: "star".to_owned() }
}

#[test]
fn an_icon_shortcode_is_a_run_of_its_own_between_the_text_around_it() {
    let host = Host { icons: vec![icon(2, 13)], ..Host::default() };
    let scene =
        laid_by(&host, 1000.0, vec![paragraph(vec![text("a :icon-star: b")])]).unwrap_or_default();
    let runs = runs_of(&scene);
    let texts: Vec<&str> = runs.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(texts, ["a", "\u{2003}", "b"]);
    assert_eq!(runs[1].paints, Some(RunPaint::Icon { name: "star".to_owned() }));
    assert!(runs[0].paints.is_none() && runs[2].paints.is_none());
}

#[test]
fn a_range_the_text_cannot_hold_names_no_icon() {
    let reversed = icon(5, 3);
    let past = icon(0, 999);
    let inside_a_pair = icon(1, 4);
    for range in [reversed, past, inside_a_pair] {
        let host = Host { icons: vec![range], ..Host::default() };
        let scene =
            laid_by(&host, 1000.0, vec![paragraph(vec![text("😀:i:")])]).unwrap_or_default();
        let texts: Vec<&str> = runs_of(&scene).iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["😀:i:"]);
    }
}

#[test]
fn a_range_before_the_cursor_is_skipped_and_the_rest_still_reads() {
    let host = Host { icons: vec![icon(0, 3), icon(1, 2)], ..Host::default() };
    let scene = laid_by(&host, 1000.0, vec![paragraph(vec![text("abcdef")])]).unwrap_or_default();
    let texts: Vec<&str> = runs_of(&scene).iter().map(|r| r.text.as_str()).collect();
    assert_eq!(texts, ["\u{2003}", "def"]);
}

#[test]
fn emoji_are_substituted_into_the_text() {
    let host = Host { emoji: Some((":ok:", "✅")), ..Host::default() };
    let scene =
        laid_by(&host, 1000.0, vec![paragraph(vec![text("done :ok:")])]).unwrap_or_default();
    assert_eq!(runs_of(&scene)[0].text, "done ✅");
}

#[test]
fn an_embed_is_named_by_its_document_else_by_its_title_while_loading_else_by_its_id() {
    let embed = |fragment: Option<&str>| {
        paragraph(vec![
            text("see "),
            Phrasing::Embed {
                document_id: "01ID".to_owned(),
                fragment: fragment.map(str::to_owned),
            },
        ])
    };
    let label = |host: &Host, fragment| {
        let scene = laid_by(host, 1000.0, vec![embed(fragment)]).unwrap_or_default();
        runs_of(&scene)[1].text.clone()
    };
    let loaded = Host { embed: Some("Doc"), title: Some("Listed"), ..Host::default() };
    assert_eq!(label(&loaded, Some("Sec")), "Doc › Sec");
    let loading = Host { title: Some("Listed"), pending: true, ..Host::default() };
    assert_eq!(label(&loading, None), "Listed");
    let titled_only = Host { title: Some("Listed"), ..Host::default() };
    assert_eq!(label(&titled_only, None), "01ID");
    let scene = laid_by(&loaded, 1000.0, vec![embed(Some(""))]).unwrap_or_default();
    let want = LinkProvenance::Embed { document_id: "01ID".to_owned(), fragment: None };
    assert_eq!(runs_of(&scene)[1].link, Some(want));
}

#[test]
fn a_lone_picture_of_known_size_is_a_figure_scaled_to_the_column() {
    let image = ImageRef { href: "img:a".to_owned(), width: Some(400.0), height: Some(200.0) };
    let host = Host { image: Some(image), ..Host::default() };
    let picture = |alt: Option<&str>| Phrasing::Image {
        url: "a".to_owned(),
        title: None,
        alt: alt.map(str::to_owned),
    };
    let blocks = vec![paragraph(vec![picture(Some("alt"))]), paragraph(vec![picture(None)])];
    let scene = laid_by(&host, 100.0, blocks).unwrap_or_default();
    let (SceneNode::Paragraph(first), SceneNode::Paragraph(second)) =
        (&scene.nodes[0], &scene.nodes[1])
    else {
        return;
    };
    assert_eq!((first.bbox.w, first.bbox.h), (100.0, 50.0));
    assert_eq!(first.runs[0].baseline, Some(50.0));
    assert_eq!(first.runs[0].text, "alt");
    same(second.bbox.y, 50.0 + 12.0);
    assert_eq!(second.runs[0].text, "\u{2002}");
    let wide = laid_by(&host, 1000.0, vec![paragraph(vec![picture(None)])]).unwrap_or_default();
    let SceneNode::Paragraph(only) = &wide.nodes[0] else { return };
    assert_eq!((only.bbox.w, only.bbox.h), (400.0, 200.0));
}

#[test]
fn a_picture_among_text_or_of_unknown_size_is_set_as_prose() {
    let sized = ImageRef { href: "img:a".to_owned(), width: Some(400.0), height: Some(200.0) };
    let unsized_ = ImageRef { href: "img:a".to_owned(), width: None, height: Some(200.0) };
    let picture = Phrasing::Image { url: "a".to_owned(), title: None, alt: None };
    for (image, children) in
        [(sized, vec![text("x"), picture.clone()]), (unsized_, vec![picture.clone()])]
    {
        let host = Host { image: Some(image), ..Host::default() };
        let scene = laid_by(&host, 100.0, vec![paragraph(children)]).unwrap_or_default();
        let SceneNode::Paragraph(block) = &scene.nodes[0] else { return };
        same(block.bbox.h, LINE);
    }
}

#[test]
fn a_picture_sized_zero_negative_or_infinite_is_set_as_prose() {
    let picture = Phrasing::Image { url: "a".to_owned(), title: None, alt: None };
    for (width, height) in [
        (0.0, 50.0),
        (-5.0, 50.0),
        (f64::INFINITY, 50.0),
        (f64::NAN, 50.0),
        (50.0, 0.0),
        (50.0, -5.0),
        (50.0, f64::INFINITY),
    ] {
        let image = ImageRef { href: "i".to_owned(), width: Some(width), height: Some(height) };
        let host = Host { image: Some(image), ..Host::default() };
        let scene =
            laid_by(&host, 100.0, vec![paragraph(vec![picture.clone()])]).unwrap_or_default();
        let SceneNode::Paragraph(block) = &scene.nodes[0] else { return };
        same(block.bbox.h, LINE);
    }
}

#[test]
fn a_figure_is_drawn_at_its_own_size_where_the_column_is_unusable() {
    let image = ImageRef { href: "i".to_owned(), width: Some(400.0), height: Some(200.0) };
    let host = Host { image: Some(image), ..Host::default() };
    let picture = Phrasing::Image { url: "a".to_owned(), title: None, alt: None };
    for column in [0.0, -1.0, f64::INFINITY, f64::NAN] {
        let scene =
            laid_by(&host, column, vec![paragraph(vec![picture.clone()])]).unwrap_or_default();
        let SceneNode::Paragraph(block) = &scene.nodes[0] else { return };
        same(block.bbox.w, 400.0);
        same(block.bbox.h, 200.0);
    }
}

#[test]
fn a_padding_that_is_not_a_positive_number_takes_no_room() {
    let code = Phrasing::InlineCode { value: "ab".to_owned() };
    for padding in [0.0, -3.0, f64::INFINITY, f64::NAN] {
        let theme = MarkdownTheme { inline_code_padding_x_px: padding, ..MarkdownTheme::node() };
        let scene =
            laid_with(&theme, &Host::default(), 1000.0, vec![paragraph(vec![code.clone()])])
                .unwrap_or_default();
        let run = runs_of(&scene)[0];
        same(run.bbox.x, 0.0);
    }
}
