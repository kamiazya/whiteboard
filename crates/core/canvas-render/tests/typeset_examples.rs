//! The typesetter's rules, one example each, in numbers a reader can check by
//! hand: the fake measurer charges 9.6px a character at the node theme's 16px
//! body, and a line box is 24.8px.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::{FontDescriptor, Measure, VerticalMetrics};
use whiteboard_canvas_render::theme::markdown::MarkdownTheme;
use whiteboard_canvas_render::typeset::{
    CodeToken, CodeTokenLines, CodeTokenizer, DiagramRenderer, IconRange, ImageRef, InlineSeams,
    MathRenderer, Rendered, SyntaxFills, TokenRole, TypesetOptions, Unsupported,
    typeset_mdast_blocks,
};
use whiteboard_model::mdast::{Flow, ListItem, Phrasing, Root, TableCell, TableRow};
use whiteboard_scene::{LinkProvenance, RunPaint, Scene, SceneNode, SvgFragmentNode, TextRunNode};

/// A host with whatever answers a test gives it; by default it knows nothing.
#[derive(Default)]
struct Host {
    icons: Vec<IconRange>,
    /// `(from, to)`: every `from` in a text is read as `to`.
    emoji: Option<(&'static str, &'static str)>,
    title: Option<&'static str>,
    embed: Option<&'static str>,
    pending: bool,
    image: Option<ImageRef>,
}

impl InlineSeams for Host {
    fn expand_emoji(&self, text: &str) -> String {
        self.emoji.map_or_else(|| text.to_owned(), |(from, to)| text.replace(from, to))
    }
    fn icon_ranges(&self, _: &str) -> Vec<IconRange> {
        self.icons.clone()
    }
    fn document_title(&self, _: &str) -> Option<String> {
        self.title.map(str::to_owned)
    }
    fn embed_name(&self, _: &str) -> Option<String> {
        self.embed.map(str::to_owned)
    }
    fn embed_pending(&self, _: &str) -> bool {
        self.pending
    }
    fn image_reference(&self, _: &str) -> Option<ImageRef> {
        self.image.clone()
    }
}

/// Bit equality, so a last-bit difference is a failure and no float is compared with `==`.
fn same(got: f64, want: f64) {
    assert_eq!(got.to_bits(), want.to_bits(), "{got} against {want}");
}

const LINE: f64 = 16.0 * 1.55;

fn text(value: &str) -> Phrasing {
    Phrasing::Text { value: value.to_owned() }
}

fn laid(width: f64, blocks: Vec<Flow>) -> Result<Scene, Unsupported> {
    laid_by(&Host::default(), width, blocks)
}

fn laid_by(host: &Host, width: f64, blocks: Vec<Flow>) -> Result<Scene, Unsupported> {
    laid_with(&MarkdownTheme::node(), host, width, blocks)
}

fn laid_with(
    theme: &MarkdownTheme,
    host: &Host,
    width: f64,
    blocks: Vec<Flow>,
) -> Result<Scene, Unsupported> {
    let measure = FakeMeasure::default();
    let options = TypesetOptions::new(&measure, width, "sans-serif", theme, host);
    typeset_mdast_blocks(&Root { children: blocks }, &options)
}

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

fn paragraph(children: Vec<Phrasing>) -> Flow {
    Flow::Paragraph { children }
}

#[test]
fn a_block_kind_not_yet_carried_is_named() {
    let item = ListItem { checked: None, spread: false, children: Vec::new() };
    let cases: Vec<(Flow, &str)> = vec![
        (Flow::Blockquote { children: Vec::new() }, "blockquote"),
        (Flow::List { ordered: None, start: None, spread: false, children: vec![item] }, "list"),
        (
            Flow::Table {
                align: Vec::new(),
                children: vec![TableRow { children: vec![TableCell { children: Vec::new() }] }],
            },
            "table",
        ),
        (paragraph(vec![Phrasing::Embed { document_id: "x".to_owned(), fragment: None }]), "embed"),
    ];
    for (block, name) in cases {
        assert_eq!(laid(100.0, vec![block]).err(), Some(Unsupported(name)));
    }
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
    let SceneNode::Paragraph(block) = &scene.nodes[0] else {
        panic!("scene node is not the expected variant")
    };
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
    let SceneNode::Paragraph(block) = &scene.nodes[0] else {
        panic!("scene node is not the expected variant")
    };
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
        panic!("scene node is not the expected variant");
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
    let SceneNode::Paragraph(block) = &scene.nodes[0] else {
        panic!("scene node is not the expected variant")
    };
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
    let empty = icon(2, 2);
    let starts_inside_a_pair = icon(1, 4);
    for range in [reversed, past, empty, starts_inside_a_pair] {
        let host = Host { icons: vec![range], ..Host::default() };
        let scene =
            laid_by(&host, 1000.0, vec![paragraph(vec![text("😀:i:")])]).unwrap_or_default();
        let texts: Vec<&str> = runs_of(&scene).iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["😀:i:"]);
    }
    let ends_inside_a_pair = Host { icons: vec![icon(0, 4)], ..Host::default() };
    let scene = laid_by(&ends_inside_a_pair, 1000.0, vec![paragraph(vec![text(":i:😀")])])
        .unwrap_or_default();
    let texts: Vec<&str> = runs_of(&scene).iter().map(|r| r.text.as_str()).collect();
    assert_eq!(texts, [":i:😀"]);
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
        panic!("scene node is not the expected variant");
    };
    assert_eq!((first.bbox.w, first.bbox.h), (100.0, 50.0));
    assert_eq!(first.runs[0].baseline, Some(50.0));
    assert_eq!(first.runs[0].text, "alt");
    same(second.bbox.y, 50.0 + 12.0);
    assert_eq!(second.runs[0].text, "\u{2002}");
    let wide = laid_by(&host, 1000.0, vec![paragraph(vec![picture(None)])]).unwrap_or_default();
    let SceneNode::Paragraph(only) = &wide.nodes[0] else {
        panic!("scene node is not the expected variant")
    };
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
        let SceneNode::Paragraph(block) = &scene.nodes[0] else {
            panic!("scene node is not the expected variant")
        };
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
        let SceneNode::Paragraph(block) = &scene.nodes[0] else {
            panic!("scene node is not the expected variant")
        };
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
        let SceneNode::Paragraph(block) = &scene.nodes[0] else {
            panic!("scene node is not the expected variant")
        };
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

/// The fake measurer, except that `z` and `あ` take no room at all.
struct ZeroWidthFace;

impl Measure for ZeroWidthFace {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        let inked = text.replace(['z', 'あ'], "");
        FakeMeasure::default().advance_width(&inked, font)
    }
    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        FakeMeasure::default().vertical_metrics(font)
    }
}

/// Two zero-width runs leave the cursor at 0 although the line is not empty,
/// and the second may not be parted from the `。` that follows it. A cursor at
/// 0 is read as an empty line, so the `。` overflows where it stands instead of
/// taking the run it is joined to down a line with it.
#[test]
fn a_zero_width_stretch_is_not_moved_down_with_what_it_is_joined_to() {
    let theme = MarkdownTheme::node();
    let host = Host::default();
    let options = TypesetOptions::new(&ZeroWidthFace, 5.0, "sans-serif", &theme, &host);
    let children = vec![text("z"), text("あ"), text("。")];
    let root = Root { children: vec![paragraph(children)] };
    let scene = typeset_mdast_blocks(&root, &options).unwrap_or_default();
    let placed: Vec<(&str, f64, f64)> =
        runs_of(&scene).iter().map(|r| (r.text.as_str(), r.bbox.x, r.bbox.y)).collect();
    assert_eq!(placed, [("z", 0.0, 0.0), ("あ", 0.0, 0.0), ("。", 0.0, 0.0)]);
    let SceneNode::Paragraph(block) = &scene.nodes[0] else {
        panic!("scene node is not the expected variant")
    };
    same(block.bbox.h, LINE);
}

fn first(scene: &Scene) -> &SceneNode {
    &scene.nodes[0]
}

#[test]
fn a_rule_raw_html_and_a_definition_are_laid_out_in_flow() {
    let blocks = vec![
        Flow::ThematicBreak,
        Flow::Html { value: "<br>".to_owned() },
        Flow::Definition {
            identifier: "ref".to_owned(),
            label: None,
            url: "u".to_owned(),
            title: None,
        },
        paragraph(vec![text("x")]),
    ];
    let scene = laid(100.0, blocks).unwrap_or_default();
    let SceneNode::ThematicBreak(rule) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    same(rule.bbox.h, 1.0);
    assert_eq!(rule.appearance.as_ref().and_then(|a| a.fill_opacity), Some(0.35));
    let SceneNode::RawHtml(html) = &scene.nodes[1] else {
        panic!("scene node is not the expected variant")
    };
    same(html.bbox.y, 1.0 + 12.0);
    same(html.bbox.h, LINE);
    let SceneNode::UnresolvedReference(marker) = &scene.nodes[2] else {
        panic!("scene node is not the expected variant")
    };
    same(marker.bbox.y, 13.0 + LINE + 12.0);
    same(marker.bbox.h, 0.0);
    let SceneNode::Paragraph(next) = &scene.nodes[3] else {
        panic!("scene node is not the expected variant")
    };
    same(next.bbox.y, marker.bbox.y);
}

struct Maths(Option<Rendered>);

impl MathRenderer for Maths {
    fn render_math(&self, _: &str) -> Option<Rendered> {
        self.0.clone()
    }
}

fn math_with(renderer: Option<&Maths>, value: &str, width: f64) -> SvgFragmentNode {
    let theme = MarkdownTheme::node();
    let measure = FakeMeasure::default();
    let host = Host::default();
    let options = TypesetOptions {
        math: renderer.map(|m| m as &dyn MathRenderer),
        ..TypesetOptions::new(&measure, width, "sans-serif", &theme, &host)
    };
    let math = Flow::Math { value: value.to_owned(), meta: None };
    let scene = typeset_mdast_blocks(&Root { children: vec![math] }, &options).unwrap_or_default();
    let SceneNode::SvgFragment(fragment) = scene.nodes[0].clone() else {
        unreachable!("the scene node is not the variant this helper reads")
    };
    fragment
}

#[test]
fn display_math_without_a_renderer_is_its_escaped_source_a_code_line_tall_per_line() {
    let fragment = math_with(None, "a < b\nc", 100.0);
    assert_eq!(fragment.svg, "<text y=\"0.8em\">a &lt; b\nc</text>");
    same(fragment.bbox.w, 100.0);
    same(fragment.bbox.h, 2.0 * (16.0 * 0.85 * 1.45));
}

#[test]
fn a_renderer_with_no_answer_leaves_the_source() {
    let fragment = math_with(Some(&Maths(None)), "x", 100.0);
    assert!(fragment.svg.starts_with("<text"));
}

#[test]
fn a_renderers_markup_is_sized_by_lines_and_its_fragment_by_its_own_size() {
    let markup = Maths(Some(Rendered::Markup("<g/>".to_owned())));
    let fragment = math_with(Some(&markup), "x\ny\nz", 100.0);
    assert_eq!(fragment.svg, "<g/>");
    same(fragment.bbox.h, 3.0 * (16.0 * 0.85 * 1.45));
    let sized =
        |width, height| Maths(Some(Rendered::Fragment { svg: "<g/>".to_owned(), width, height }));
    let fit = math_with(Some(&sized(Some(40.0), Some(20.0))), "x", 100.0);
    same(fit.bbox.w, 40.0);
    same(fit.bbox.h, 20.0);
    let wide = math_with(Some(&sized(Some(500.0), Some(0.0))), "x", 100.0);
    same(wide.bbox.w, 100.0);
    same(wide.bbox.h, 16.0 * 0.85 * 1.45);
    let unsized_ = math_with(Some(&sized(None, None)), "x", 100.0);
    same(unsized_.bbox.w, 100.0);
}

#[test]
fn a_fragment_in_a_column_that_is_not_a_number_is_as_wide_as_that_column() {
    let sized = Maths(Some(Rendered::Fragment {
        svg: "<g/>".to_owned(),
        width: Some(40.0),
        height: Some(20.0),
    }));
    assert!(math_with(Some(&sized), "x", f64::NAN).bbox.w.is_nan());
}

fn fence(value: &str, lang: Option<&str>, width: f64) -> whiteboard_scene::CodeBlockNode {
    let flow = Flow::Code { value: value.to_owned(), lang: lang.map(str::to_owned), meta: None };
    let scene = laid(width, vec![flow]).unwrap_or_default();
    let SceneNode::CodeBlock(block) = first(&scene).clone() else {
        unreachable!("the scene node is not the variant this helper reads")
    };
    block
}

#[test]
fn a_fence_is_a_panel_with_one_run_per_non_empty_source_line() {
    let block = fence("ab\n\ncd", Some("js"), 400.0);
    let runs = block.runs.unwrap_or_default();
    assert_eq!(runs.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), ["ab", "cd"]);
    assert!(runs.iter().all(|r| r.code));
    let line = 16.0 * 0.85 * 1.45;
    same(block.bbox.h, 3.0 * line + 32.0);
    same(runs[0].bbox.x, 16.0);
    same(runs[0].bbox.y, 16.0);
    same(runs[1].bbox.y, 16.0 + 2.0 * line);
    assert_eq!(block.lang.as_deref(), Some("js"));
    assert_eq!(block.radius, Some(6.0));
}

#[test]
fn a_fence_line_is_cut_to_the_panel_and_never_wrapped() {
    let block = fence(&"w".repeat(100), None, 100.0);
    let runs = block.runs.unwrap_or_default();
    assert_eq!(runs.len(), 1);
    assert!(runs[0].truncated);
    assert!(runs[0].bbox.x + runs[0].bbox.w <= 100.0 - 16.0);
    assert!(block.lang.is_none());
}

struct Lines(Option<CodeTokenLines>);

impl CodeTokenizer for Lines {
    fn tokenize(&self, _: &str, _: &str) -> Option<CodeTokenLines> {
        self.0.clone()
    }
}

fn token(text: &str, role: Option<TokenRole>) -> CodeToken {
    CodeToken { text: text.to_owned(), role }
}

fn fence_with(tokenizer: &Lines, value: &str) -> Vec<TextRunNode> {
    let theme = MarkdownTheme::node();
    let measure = FakeMeasure::default();
    let host = Host::default();
    let syntax = SyntaxFills { keyword: Some("#f00".to_owned()), ..SyntaxFills::default() };
    let options = TypesetOptions {
        highlight: Some(tokenizer),
        syntax: Some(&syntax),
        text_fill: Some("#111"),
        ..TypesetOptions::new(&measure, 400.0, "sans-serif", &theme, &host)
    };
    let flow = Flow::Code { value: value.to_owned(), lang: Some("js".to_owned()), meta: None };
    let scene = typeset_mdast_blocks(&Root { children: vec![flow] }, &options).unwrap_or_default();
    let SceneNode::CodeBlock(block) = first(&scene).clone() else {
        unreachable!("the scene node is not the variant this helper reads")
    };
    block.runs.unwrap_or_default()
}

#[test]
fn tokens_are_placed_left_to_right_and_filled_by_role() {
    let lines = vec![vec![token("if", Some(TokenRole::Keyword)), token(" x", None)]];
    let runs = fence_with(&Lines(Some(lines)), "if x");
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].appearance.as_ref().and_then(|a| a.fill.as_deref()), Some("#f00"));
    assert_eq!(runs[1].appearance.as_ref().and_then(|a| a.fill.as_deref()), Some("#111"));
    same(runs[1].bbox.x, 16.0 + runs[0].bbox.w);
}

#[test]
fn an_unusable_highlight_is_plain_source() {
    let wrong_count = vec![vec![token("a", None)], vec![token("b", None)]];
    for answer in [None, Some(wrong_count)] {
        let runs = fence_with(&Lines(answer), "ab");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].text, "ab");
    }
}

struct Diagrams;

impl DiagramRenderer for Diagrams {
    fn render_diagram(&self, lang: &str, _: &str) -> Option<Rendered> {
        (lang == "dot").then(|| Rendered::Markup("<g/>".to_owned()))
    }
}

#[test]
fn a_diagram_renderer_that_answers_takes_over_the_fence() {
    let theme = MarkdownTheme::node();
    let measure = FakeMeasure::default();
    let host = Host::default();
    let options = TypesetOptions {
        diagram: Some(&Diagrams),
        ..TypesetOptions::new(&measure, 100.0, "sans-serif", &theme, &host)
    };
    let fence = |lang: Option<&str>| Flow::Code {
        value: "a".to_owned(),
        lang: lang.map(str::to_owned),
        meta: None,
    };
    let blocks = vec![fence(Some("dot")), fence(Some("js")), fence(Some("")), fence(None)];
    let scene = typeset_mdast_blocks(&Root { children: blocks }, &options).unwrap_or_default();
    assert!(matches!(scene.nodes[0], SceneNode::SvgFragment(_)));
    for node in &scene.nodes[1..] {
        assert!(matches!(node, SceneNode::CodeBlock(_)));
    }
}
