//! The block-level rules, one example each: a rule, raw html, a definition,
//! display math, a fence, a blockquote, a list with its task boxes and a table.

#[path = "typeset_support/examples.rs"]
mod examples;

use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::theme::markdown::MarkdownTheme;
use whiteboard_canvas_render::typeset::{
    CodeToken, CodeTokenLines, CodeTokenizer, DiagramRenderer, MathRenderer, Rendered, SyntaxFills,
    TokenRole, TypesetOptions, select_markdown_section, typeset_mdast_blocks,
};
use whiteboard_model::mdast::{Flow, ListItem, Root, TableCell, TableRow};
use whiteboard_scene::{Scene, SceneNode, SvgFragmentNode, TextRunNode};

use examples::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

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

fn item(checked: Option<bool>, children: Vec<Flow>) -> ListItem {
    ListItem { checked, spread: false, children }
}

fn bullets(ordered: bool, start: f64, items: Vec<ListItem>) -> Flow {
    Flow::List { ordered: Some(ordered), start: Some(start), spread: false, children: items }
}

fn words(value: &str) -> Vec<Flow> {
    vec![paragraph(vec![text(value)])]
}

#[test]
fn a_blockquote_indents_its_content_behind_a_rail_and_mutes_it() {
    let quote = Flow::Blockquote { children: words("hi") };
    let scene = laid(200.0, vec![quote]).unwrap_or_default();
    let SceneNode::Blockquote(q) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    same(q.bbox.w, 200.0);
    assert!((q.bbox.h - LINE).abs() < 1e-9);
    assert_eq!(q.appearance.as_ref().and_then(|a| a.fill_opacity), Some(0.7));
    let SceneNode::Shape(bar) = &q.children[0] else {
        panic!("scene node is not the expected variant")
    };
    same(bar.bbox.w, 4.0);
    assert!((bar.bbox.h - LINE).abs() < 1e-9);
    assert_eq!(bar.radius, Some(2.0));
    let SceneNode::Paragraph(p) = &q.children[1] else {
        panic!("scene node is not the expected variant")
    };
    same(p.bbox.x, 20.0);
    same(p.bbox.w, 180.0);
}

#[test]
fn a_list_item_stores_its_marker_left_of_its_content_and_its_box_by_depth() {
    let nested = bullets(false, 1.0, vec![item(None, words("inner"))]);
    let outer = item(None, vec![paragraph(vec![text("outer")]), nested]);
    let scene = laid(300.0, vec![bullets(false, 1.0, vec![outer])]).unwrap_or_default();
    let SceneNode::List(list) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    same(list.depth, 0.0);
    let top = &list.items[0];
    same(top.bbox.x, 22.0);
    same(top.bbox.w, 300.0 - 22.0);
    let SceneNode::TextRun(marker) = &top.children[0] else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!(marker.text, "\u{2022}");
    same(marker.bbox.x, -(9.6 + 8.0));
    let SceneNode::List(inner) = &top.children[2] else {
        panic!("scene node is not the expected variant")
    };
    same(inner.depth, 1.0);
    same(inner.items[0].bbox.x, 44.0);
    same(inner.items[0].bbox.w, 300.0 - 22.0 - 44.0);
}

#[test]
fn an_ordinal_counts_from_the_start_and_aligns_right_against_the_content() {
    let items = vec![item(None, words("a")), item(None, words("b"))];
    let scene = laid(300.0, vec![bullets(true, 9.0, items)]).unwrap_or_default();
    let SceneNode::List(list) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!(list.items[0].ordinal, Some(9.0));
    assert_eq!(list.items[1].ordinal, Some(10.0));
    let (SceneNode::TextRun(nine), SceneNode::TextRun(ten)) =
        (&list.items[0].children[0], &list.items[1].children[0])
    else {
        panic!("scene node is not the expected variant");
    };
    assert_eq!((nine.text.as_str(), ten.text.as_str()), ("9.", "10."));
    same(nine.bbox.x + nine.bbox.w, ten.bbox.x + ten.bbox.w);
    assert!(list.ordered);
}

#[test]
fn a_task_item_draws_a_box_and_a_tick_instead_of_a_bullet() {
    let items = vec![item(Some(true), words("done")), item(Some(false), words("todo"))];
    let scene = laid(300.0, vec![bullets(false, 1.0, items)]).unwrap_or_default();
    let SceneNode::List(list) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    let done = &list.items[0];
    assert_eq!(done.checked, Some(true));
    let SceneNode::Shape(frame) = &done.children[0] else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!(frame.task_box.map(|t| t.checked), Some(true));
    same(frame.bbox.w, 13.0);
    same(frame.bbox.x, -(13.0 + 8.0));
    assert!(matches!(&done.children[1], SceneNode::Edge(e) if e.id == "task-tick"));
    let todo = &list.items[1];
    assert_eq!(todo.checked, Some(false));
    assert!(matches!(&todo.children[1], SceneNode::Paragraph(_)));
}

fn row(cells: &[&str]) -> TableRow {
    TableRow { children: cells.iter().map(|c| TableCell { children: vec![text(c)] }).collect() }
}

fn table_of(width: f64, rows: Vec<TableRow>) -> whiteboard_scene::TableBlockNode {
    let scene =
        laid(width, vec![Flow::Table { align: Vec::new(), children: rows }]).unwrap_or_default();
    let SceneNode::Table(table) = first(&scene).clone() else {
        unreachable!("the scene node is not the variant this helper reads");
    };
    table
}

#[test]
fn a_table_sizes_each_column_to_its_widest_cell_set_in_bold_and_pads_it() {
    let table = table_of(1000.0, vec![row(&["a", "bbbb"]), row(&["cc", "d"])]);
    let widths: Vec<f64> = table.rows[0].cells.iter().map(|c| c.bbox.w).collect();
    assert!((widths[0] - (2.0 * 9.6 + 26.0)).abs() < 1e-9);
    assert!((widths[1] - (4.0 * 9.6 + 26.0)).abs() < 1e-9);
    same(table.rows[0].cells[1].bbox.x, widths[0]);
    assert_eq!(table.rows[0].header, Some(true));
    assert_eq!(table.rows[1].header, None);
    assert!(table.rows[0].appearance.is_some());
    assert!(table.rows[1].appearance.is_none());
    assert!(table.rows[0].cells[0].runs[0].strong);
    assert!(!table.rows[1].cells[0].runs[0].strong);
    same(table.rows[0].cells[0].runs[0].bbox.x, 13.0);
    same(table.rows[0].bbox.h, LINE + 12.0);
}

#[test]
fn a_table_wider_than_its_column_is_scaled_into_it_down_to_a_floor() {
    let wide = table_of(200.0, vec![row(&["wwwwwwwwwwwwwwww", "x", "wwwwwwwwwwwwwwww"])]);
    let widths: Vec<f64> = wide.rows[0].cells.iter().map(|c| c.bbox.w).collect();
    let floor = 26.0 + 16.0;
    same(widths[1], floor);
    assert!((widths.iter().sum::<f64>() - 200.0).abs() < 1e-6);
    same(wide.bbox.w, widths.iter().sum::<f64>());
}

#[test]
fn a_ragged_row_keeps_the_columns_it_has_and_a_row_of_nothing_is_one_line_tall() {
    let table = table_of(
        1000.0,
        vec![row(&["a", "b", "c"]), row(&["d"]), TableRow { children: Vec::new() }],
    );
    assert_eq!(table.rows[1].cells.len(), 1);
    assert_eq!(table.rows[2].cells.len(), 0);
    same(table.rows[2].bbox.h, LINE + 12.0);
}

#[test]
fn a_section_runs_from_its_heading_to_the_next_of_the_same_or_a_shallower_depth() {
    let h = |depth, title: &str| Flow::Heading { depth, children: vec![text(title)] };
    let root = Root {
        children: vec![
            h(1, "Top"),
            paragraph(vec![text("t")]),
            h(2, "Sub"),
            h(3, "Deep"),
            h(2, "Sub2"),
        ],
    };
    let sub = select_markdown_section(&root, "sub");
    assert_eq!(sub.map(|r| r.children.len()), Some(2));
    assert_eq!(select_markdown_section(&root, "Top").map(|r| r.children.len()), Some(5));
    assert!(select_markdown_section(&root, "  ").is_none());
    assert!(select_markdown_section(&root, "nothing").is_none());
}

/// A measurer that charges bold twice what regular costs, so a layout that
/// measures in the wrong weight is told apart.
struct BoldCostsMore;

impl whiteboard_canvas_render::measure::Measure for BoldCostsMore {
    fn advance_width(
        &self,
        text: &str,
        font: &whiteboard_canvas_render::measure::FontDescriptor,
    ) -> f64 {
        let weight = if font.weight >= 700.0 { 2.0 } else { 1.0 };
        weight * 10.0 * whiteboard_canvas_render::fake_measure::utf16_len(text)
    }
    fn vertical_metrics(
        &self,
        font: &whiteboard_canvas_render::measure::FontDescriptor,
    ) -> whiteboard_canvas_render::measure::VerticalMetrics {
        whiteboard_canvas_render::measure::VerticalMetrics {
            ascent: font.size_px,
            descent: 0.0,
            line_gap: 0.0,
        }
    }
}

#[test]
fn a_table_column_is_sized_for_its_text_in_bold() {
    let theme = MarkdownTheme::node();
    let host = Host::default();
    let options = TypesetOptions::new(&BoldCostsMore, 10_000.0, "sans-serif", &theme, &host);
    let table = Flow::Table { align: Vec::new(), children: vec![row(&["abc"])] };
    let scene = typeset_mdast_blocks(&Root { children: vec![table] }, &options).unwrap_or_default();
    let SceneNode::Table(table) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    same(table.rows[0].cells[0].bbox.w, 2.0 * 30.0 + 26.0);
}

#[test]
fn a_ticks_stroke_is_one_and_a_half_borders_wide_and_never_thinner_than_one_and_a_half() {
    let checked = || vec![item(Some(true), words("x"))];
    for (border, want) in [(4.0, 6.0), (1.0, 1.5), (0.5, 1.5)] {
        let theme = MarkdownTheme { border_width_px: border, ..MarkdownTheme::node() };
        let host = Host::default();
        let measure = FakeMeasure::default();
        let options = TypesetOptions::new(&measure, 300.0, "sans-serif", &theme, &host);
        let list = bullets(false, 1.0, checked());
        let scene =
            typeset_mdast_blocks(&Root { children: vec![list] }, &options).unwrap_or_default();
        let SceneNode::List(list) = first(&scene) else {
            panic!("scene node is not the expected variant")
        };
        let SceneNode::Edge(tick) = &list.items[0].children[1] else {
            panic!("scene node is not the expected variant")
        };
        same(tick.appearance.as_ref().and_then(|a| a.stroke_width).unwrap_or(0.0), want);
    }
}

/// `Math.max` answers NaN when either side is NaN, so a cell padding that is
/// not a number makes its column NaN wide rather than as wide as nothing.
#[test]
fn a_cell_padding_that_is_not_a_number_makes_its_column_not_a_number_wide() {
    let theme = MarkdownTheme { table_cell_padding_x_px: f64::NAN, ..MarkdownTheme::node() };
    let table = Flow::Table { align: Vec::new(), children: vec![row(&["ab"])] };
    let scene = laid_with(&theme, &Host::default(), f64::INFINITY, vec![table]).unwrap_or_default();
    let SceneNode::Table(table) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    assert!(table.rows[0].cells[0].bbox.w.is_nan());
}
