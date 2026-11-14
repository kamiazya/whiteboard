//! Each scene node kind as the TypeScript's object: `kind` first, then its
//! fields, an optional one present only when set.

use whiteboard_scene::{
    Annotates, AnnotatesKind, Appearance, BlockquoteNode, BoundingBox, CodeBlockNode, EdgeEnd,
    EmbedPlaceholderNode, EmbedReason, EmbedResolvedNode, GroupSceneNode, HeadingBlockNode,
    IconSceneNode, ImageFit, ImageSceneNode, LinkProvenance, ListBlockNode, ListItemNode,
    ResolvedEdgeNode, RunPaint, SceneInk, SceneNode, ShapeSceneNode, SvgFragmentNode,
    TableBlockNode, TextRunNode,
};

use super::Tree;

type Fields = Vec<(&'static str, Tree)>;

fn text(value: &str) -> Tree {
    Tree::text(value)
}

const fn number(value: f64) -> Tree {
    Tree::Number(value)
}

/// `kind` and `bbox`, the head every node but an edge opens with.
fn head(kind: &str, bbox: &BoundingBox) -> Fields {
    vec![("kind", text(kind)), ("bbox", bbox_tree(bbox))]
}

fn bbox_tree(b: &BoundingBox) -> Tree {
    Tree::Object(vec![
        ("x", number(b.x)),
        ("y", number(b.y)),
        ("w", number(b.w)),
        ("h", number(b.h)),
    ])
}

/// A flag the TypeScript writes as `true` when set and leaves out otherwise.
fn flag(fields: &mut Fields, key: &'static str, set: bool) {
    if set {
        fields.push((key, Tree::Flag(true)));
    }
}

fn put(fields: &mut Fields, key: &'static str, value: Option<Tree>) {
    fields.extend(value.map(|value| (key, value)));
}

fn appearance(a: &Appearance) -> Tree {
    let mut f = Fields::new();
    put(&mut f, "fill", a.fill.as_deref().map(text));
    put(&mut f, "stroke", a.stroke.as_deref().map(text));
    put(&mut f, "strokeWidth", a.stroke_width.map(number));
    put(&mut f, "fontFamily", a.font_family.as_deref().map(text));
    put(&mut f, "fontSize", a.font_size.map(number));
    put(&mut f, "fillOpacity", a.fill_opacity.map(number));
    put(&mut f, "strokeOpacity", a.stroke_opacity.map(number));
    put(&mut f, "halo", a.halo.as_deref().map(text));
    put(&mut f, "strokeDasharray", a.stroke_dasharray.as_deref().map(text));
    flag(&mut f, "dropShadow", a.drop_shadow);
    put(&mut f, "glow", a.glow.map(|g| Tree::Object(vec![("radiusPx", number(g.radius_px))])));
    Tree::Object(f)
}

fn appearance_of(a: Option<&Appearance>) -> Option<Tree> {
    a.map(appearance)
}

fn link(link: &LinkProvenance) -> Tree {
    let mut f = Fields::new();
    match link {
        LinkProvenance::Link { href, title } => {
            f.extend([("kind", text("link")), ("href", text(href))]);
            put(&mut f, "title", title.as_deref().map(text));
        }
        LinkProvenance::WikiLink { document_id, alias, fragment } => {
            f.extend([("kind", text("wikiLink")), ("documentId", text(document_id))]);
            put(&mut f, "alias", alias.as_deref().map(text));
            put(&mut f, "fragment", fragment.as_deref().map(text));
        }
        LinkProvenance::Embed { document_id, fragment } => {
            f.extend([("kind", text("embed")), ("documentId", text(document_id))]);
            put(&mut f, "fragment", fragment.as_deref().map(text));
        }
    }
    Tree::Object(f)
}

fn paints(p: &RunPaint) -> Tree {
    match p {
        RunPaint::Image { src } => Tree::Object(vec![("kind", text("image")), ("src", text(src))]),
        RunPaint::Icon { name } => Tree::Object(vec![("kind", text("icon")), ("name", text(name))]),
    }
}

fn annotates(a: &Annotates) -> Tree {
    let kind = match a.kind {
        AnnotatesKind::Edge => "edge",
        AnnotatesKind::Node => "node",
    };
    Tree::Object(vec![("kind", text(kind)), ("id", text(&a.id))])
}

fn run(r: &TextRunNode) -> Tree {
    let mut f = head("textRun", &r.bbox);
    f.push(("text", text(&r.text)));
    flag(&mut f, "emphasis", r.emphasis);
    flag(&mut f, "strong", r.strong);
    flag(&mut f, "code", r.code);
    flag(&mut f, "deleted", r.deleted);
    flag(&mut f, "truncated", r.truncated);
    flag(&mut f, "overflows", r.overflows);
    put(&mut f, "link", r.link.as_ref().map(link));
    put(&mut f, "appearance", appearance_of(r.appearance.as_ref()));
    put(&mut f, "paints", r.paints.as_ref().map(paints));
    put(&mut f, "backdrop", appearance_of(r.backdrop.as_ref()));
    put(&mut f, "backdropPadXPx", r.backdrop_pad_x_px.map(number));
    put(&mut f, "baseline", r.baseline.map(number));
    put(&mut f, "annotates", r.annotates.as_ref().map(annotates));
    Tree::Object(f)
}

fn runs(list: &[TextRunNode]) -> Tree {
    Tree::List(list.iter().map(run).collect())
}

fn code_block(c: &CodeBlockNode) -> Tree {
    let mut f = head("codeBlock", &c.bbox);
    f.push(("value", text(&c.value)));
    put(&mut f, "lang", c.lang.as_deref().map(text));
    put(&mut f, "runs", c.runs.as_deref().map(runs));
    put(&mut f, "appearance", appearance_of(c.appearance.as_ref()));
    put(&mut f, "radius", c.radius.map(number));
    Tree::Object(f)
}

fn quote(q: &BlockquoteNode) -> Tree {
    let mut f = head("blockquote", &q.bbox);
    f.push(("children", nodes_tree(&q.children)));
    put(&mut f, "appearance", appearance_of(q.appearance.as_ref()));
    Tree::Object(f)
}

fn item(i: &ListItemNode) -> Tree {
    let mut f = head("listItem", &i.bbox);
    f.push(("children", nodes_tree(&i.children)));
    put(&mut f, "ordinal", i.ordinal.map(number));
    put(&mut f, "checked", i.checked.map(Tree::Flag));
    Tree::Object(f)
}

fn list_block(l: &ListBlockNode) -> Tree {
    let mut f = head("list", &l.bbox);
    f.extend([
        ("ordered", Tree::Flag(l.ordered)),
        ("depth", number(l.depth)),
        ("items", Tree::List(l.items.iter().map(item).collect())),
    ]);
    Tree::Object(f)
}

fn table(t: &TableBlockNode) -> Tree {
    let rows = t.rows.iter().map(|r| {
        let cells = r.cells.iter().map(|c| {
            let mut f = head("tableCell", &c.bbox);
            f.push(("runs", runs(&c.runs)));
            put(&mut f, "appearance", appearance_of(c.appearance.as_ref()));
            Tree::Object(f)
        });
        let mut f = head("tableRow", &r.bbox);
        f.push(("cells", Tree::List(cells.collect())));
        put(&mut f, "header", r.header.map(Tree::Flag));
        put(&mut f, "appearance", appearance_of(r.appearance.as_ref()));
        Tree::Object(f)
    });
    let mut f = head("table", &t.bbox);
    f.push(("rows", Tree::List(rows.collect())));
    Tree::Object(f)
}

fn ink(i: SceneInk) -> Tree {
    let mut f = vec![("style", text("sketch")), ("seed", number(f64::from(i.seed)))];
    put(&mut f, "fill", i.fill.map(|_| text("hatch")));
    Tree::Object(f)
}

fn shape(s: &ShapeSceneNode) -> Tree {
    let mut f = head("shape", &s.bbox);
    put(&mut f, "id", s.id.as_deref().map(text));
    put(&mut f, "shape", s.shape.as_deref().map(text));
    put(&mut f, "ink", s.ink.map(ink));
    flag(&mut f, "truncated", s.truncated);
    flag(&mut f, "overflows", s.overflows);
    flag(&mut f, "commentChrome", s.comment_chrome);
    let proposal = s.proposal_chrome.as_ref();
    put(
        &mut f,
        "proposalChrome",
        proposal.map(|p| Tree::Object(vec![("proposalId", text(&p.proposal_id))])),
    );
    put(&mut f, "radius", s.radius.map(number));
    put(&mut f, "appearance", appearance_of(s.appearance.as_ref()));
    put(
        &mut f,
        "taskBox",
        s.task_box.map(|t| Tree::Object(vec![("checked", Tree::Flag(t.checked))])),
    );
    Tree::Object(f)
}

const fn end_name(end: EdgeEnd) -> &'static str {
    match end {
        EdgeEnd::None => "none",
        EdgeEnd::Arrow => "arrow",
    }
}

fn edge(e: &ResolvedEdgeNode) -> Tree {
    let path = e.path.iter().map(|p| Tree::Object(vec![("x", number(p.x)), ("y", number(p.y))]));
    let mut f = vec![
        ("kind", text("edge")),
        ("id", text(&e.id)),
        ("path", Tree::List(path.collect())),
        ("fromSide", text(e.from_side.as_str())),
        ("toSide", text(e.to_side.as_str())),
        ("fromEnd", text(end_name(e.from_end))),
        ("toEnd", text(end_name(e.to_end))),
    ];
    put(&mut f, "appearance", appearance_of(e.appearance.as_ref()));
    let jump = |j: &whiteboard_scene::EdgeJumpPoint| {
        Tree::Object(vec![("segment", number(j.segment)), ("x", number(j.x)), ("y", number(j.y))])
    };
    put(
        &mut f,
        "jumps",
        e.jumps.as_ref().map(|jumps| Tree::List(jumps.iter().map(jump).collect())),
    );
    flag(&mut f, "rounded", e.rounded);
    put(&mut f, "ink", e.ink.map(ink));
    flag(&mut f, "commentChrome", e.comment_chrome);
    Tree::Object(f)
}

fn placeholder(e: &EmbedPlaceholderNode) -> Tree {
    let reason = match e.reason {
        EmbedReason::Cycle => "cycle",
        EmbedReason::DepthCap => "depthCap",
        EmbedReason::Budget => "budget",
        EmbedReason::Unresolvable => "unresolvable",
    };
    let mut f = head("embedPlaceholder", &e.bbox);
    f.extend([
        ("documentId", text(&e.document_id)),
        ("title", text(&e.title)),
        ("reason", text(reason)),
    ]);
    Tree::Object(f)
}

fn with_runs(kind: &str, bbox: &BoundingBox, list: &[TextRunNode]) -> Tree {
    let mut f = head(kind, bbox);
    f.push(("runs", runs(list)));
    Tree::Object(f)
}

fn with_text(kind: &str, bbox: &BoundingBox, key: &'static str, value: &str) -> Tree {
    let mut f = head(kind, bbox);
    f.push((key, text(value)));
    Tree::Object(f)
}

fn with_appearance(kind: &str, bbox: &BoundingBox, a: Option<&Appearance>) -> Tree {
    let mut f = head(kind, bbox);
    put(&mut f, "appearance", appearance_of(a));
    Tree::Object(f)
}

fn heading(h: &HeadingBlockNode) -> Tree {
    let mut f = head("heading", &h.bbox);
    f.extend([("level", number(f64::from(h.level))), ("runs", runs(&h.runs))]);
    Tree::Object(f)
}

fn fragment(g: &SvgFragmentNode) -> Tree {
    let mut f = head("svgFragment", &g.bbox);
    f.push(("svg", text(&g.svg)));
    put(&mut f, "role", g.role.map(|_| text("presentation")));
    Tree::Object(f)
}

fn embed_resolved(e: &EmbedResolvedNode) -> Tree {
    let mut f = head("embedResolved", &e.bbox);
    f.extend([("documentId", text(&e.document_id)), ("children", nodes_tree(&e.children))]);
    Tree::Object(f)
}

fn group(g: &GroupSceneNode) -> Tree {
    let mut f = head("group", &g.bbox);
    f.push(("children", nodes_tree(&g.children)));
    put(&mut f, "label", g.label.as_deref().map(text));
    Tree::Object(f)
}

fn image(i: &ImageSceneNode) -> Tree {
    let mut f = head("image", &i.bbox);
    f.push(("href", text(&i.href)));
    put(&mut f, "alt", i.alt.as_deref().map(text));
    let fit = |fit: ImageFit| match fit {
        ImageFit::Contain => text("contain"),
        ImageFit::Cover => text("cover"),
    };
    put(&mut f, "fit", i.fit.map(fit));
    Tree::Object(f)
}

fn icon(i: &IconSceneNode) -> Tree {
    let mut f = head("icon", &i.bbox);
    f.push(("icon", text(&i.icon)));
    put(&mut f, "appearance", appearance_of(i.appearance.as_ref()));
    Tree::Object(f)
}

fn node(n: &SceneNode) -> Tree {
    match n {
        SceneNode::Paragraph(p) => with_runs("paragraph", &p.bbox, &p.runs),
        SceneNode::Heading(h) => heading(h),
        SceneNode::CodeBlock(c) => code_block(c),
        SceneNode::ThematicBreak(t) => {
            with_appearance("thematicBreak", &t.bbox, t.appearance.as_ref())
        }
        SceneNode::RawHtml(h) => with_text("rawHtml", &h.bbox, "value", &h.value),
        SceneNode::Blockquote(q) => quote(q),
        SceneNode::List(l) => list_block(l),
        SceneNode::Table(t) => table(t),
        SceneNode::TextRun(r) => run(r),
        SceneNode::UnresolvedReference(u) => {
            with_text("unresolvedReference", &u.bbox, "identifier", &u.identifier)
        }
        SceneNode::SvgFragment(g) => fragment(g),
        SceneNode::EmbedResolved(e) => embed_resolved(e),
        SceneNode::EmbedPlaceholder(e) => placeholder(e),
        SceneNode::Group(g) => group(g),
        SceneNode::Shape(s) => shape(s),
        SceneNode::Edge(e) => edge(e),
        SceneNode::Image(i) => image(i),
        SceneNode::Icon(i) => icon(i),
        SceneNode::Glyph(g) => with_text("glyph", &g.bbox, "glyph", &g.glyph),
    }
}

/// A list of scene nodes, each as the TypeScript's object.
#[must_use]
pub fn nodes_tree(nodes: &[SceneNode]) -> Tree {
    Tree::List(nodes.iter().map(node).collect())
}
