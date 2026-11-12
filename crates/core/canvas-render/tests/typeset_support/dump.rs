//! A Rust scene as the canonical text the TypeScript's `dumpScene` writes: every
//! number as the hex of its 64 IEEE bits, keys sorted, nothing absent written.
//! Only the node kinds the typesetter has ported so far are written; a later
//! slice adds its kinds here, and an unplaced one fails loudly.

use whiteboard_scene::{
    Appearance, BoundingBox, LinkProvenance, RunPaint, Scene, SceneNode, TextRunNode,
};

fn num(value: f64) -> String {
    format!("#{:016x}", value.to_bits())
}

fn string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// `{"k":v,...}` with the keys in code unit order.
fn object(mut fields: Vec<(&str, String)>) -> String {
    fields.sort_by(|a, b| a.0.cmp(b.0));
    let body: Vec<String> =
        fields.into_iter().map(|(key, value)| format!("{}:{value}", string(key))).collect();
    format!("{{{}}}", body.join(","))
}

fn list(items: impl IntoIterator<Item = String>) -> String {
    format!("[{}]", items.into_iter().collect::<Vec<_>>().join(","))
}

fn bbox(b: &BoundingBox) -> String {
    object(vec![("x", num(b.x)), ("y", num(b.y)), ("w", num(b.w)), ("h", num(b.h))])
}

fn appearance(a: &Appearance) -> String {
    let mut fields = Vec::new();
    let mut put = |key: &'static str, value: Option<String>| {
        if let Some(value) = value {
            fields.push((key, value));
        }
    };
    put("fill", a.fill.as_deref().map(string));
    put("stroke", a.stroke.as_deref().map(string));
    put("strokeWidth", a.stroke_width.map(num));
    put("fontFamily", a.font_family.as_deref().map(string));
    put("fontSize", a.font_size.map(num));
    put("fillOpacity", a.fill_opacity.map(num));
    put("strokeOpacity", a.stroke_opacity.map(num));
    put("halo", a.halo.as_deref().map(string));
    put("strokeDasharray", a.stroke_dasharray.as_deref().map(string));
    put("dropShadow", a.drop_shadow.then(|| "true".to_owned()));
    put("glow", a.glow.map(|g| object(vec![("radiusPx", num(g.radius_px))])));
    object(fields)
}

fn link(link: &LinkProvenance) -> String {
    let opt = |v: &Option<String>| v.as_deref().map(string);
    let mut fields = Vec::new();
    match link {
        LinkProvenance::Link { href, title } => {
            fields.push(("kind", string("link")));
            fields.push(("href", string(href)));
            fields.extend(opt(title).map(|t| ("title", t)));
        }
        LinkProvenance::WikiLink { document_id, alias, fragment } => {
            fields.push(("kind", string("wikiLink")));
            fields.push(("documentId", string(document_id)));
            fields.extend(opt(alias).map(|t| ("alias", t)));
            fields.extend(opt(fragment).map(|t| ("fragment", t)));
        }
        LinkProvenance::Embed { document_id, fragment } => {
            fields.push(("kind", string("embed")));
            fields.push(("documentId", string(document_id)));
            fields.extend(opt(fragment).map(|t| ("fragment", t)));
        }
    }
    object(fields)
}

fn paints(p: &RunPaint) -> String {
    match p {
        RunPaint::Image { src } => object(vec![("kind", string("image")), ("src", string(src))]),
        RunPaint::Icon { name } => object(vec![("kind", string("icon")), ("name", string(name))]),
    }
}

fn run(r: &TextRunNode) -> String {
    let mut fields =
        vec![("kind", string("textRun")), ("bbox", bbox(&r.bbox)), ("text", string(&r.text))];
    let flags = [
        ("emphasis", r.emphasis),
        ("strong", r.strong),
        ("code", r.code),
        ("deleted", r.deleted),
        ("truncated", r.truncated),
        ("overflows", r.overflows),
    ];
    fields.extend(flags.into_iter().filter(|f| f.1).map(|f| (f.0, "true".to_owned())));
    fields.extend(r.link.as_ref().map(|l| ("link", link(l))));
    fields.extend(r.appearance.as_ref().map(|a| ("appearance", appearance(a))));
    fields.extend(r.paints.as_ref().map(|p| ("paints", paints(p))));
    fields.extend(r.backdrop.as_ref().map(|a| ("backdrop", appearance(a))));
    fields.extend(r.backdrop_pad_x_px.map(|v| ("backdropPadXPx", num(v))));
    fields.extend(r.baseline.map(|v| ("baseline", num(v))));
    object(fields)
}

fn node(n: &SceneNode) -> Result<String, String> {
    Ok(match n {
        SceneNode::Paragraph(p) => object(vec![
            ("kind", string("paragraph")),
            ("bbox", bbox(&p.bbox)),
            ("runs", list(p.runs.iter().map(run))),
        ]),
        SceneNode::Heading(h) => object(vec![
            ("kind", string("heading")),
            ("bbox", bbox(&h.bbox)),
            ("level", num(f64::from(h.level))),
            ("runs", list(h.runs.iter().map(run))),
        ]),
        SceneNode::CodeBlock(c) => code_block(c),
        SceneNode::ThematicBreak(t) => {
            let mut f = vec![("kind", string("thematicBreak")), ("bbox", bbox(&t.bbox))];
            f.extend(t.appearance.as_ref().map(|a| ("appearance", appearance(a))));
            object(f)
        }
        SceneNode::RawHtml(h) => object(vec![
            ("kind", string("rawHtml")),
            ("bbox", bbox(&h.bbox)),
            ("value", string(&h.value)),
        ]),
        SceneNode::UnresolvedReference(u) => object(vec![
            ("kind", string("unresolvedReference")),
            ("bbox", bbox(&u.bbox)),
            ("identifier", string(&u.identifier)),
        ]),
        SceneNode::SvgFragment(g) => fragment(g),
        other => return Err(format!("an unplaced scene node {other:?}")),
    })
}

pub(crate) fn dump_scene(scene: &Scene) -> Result<String, String> {
    let nodes = scene.nodes.iter().map(node).collect::<Result<Vec<_>, _>>()?;
    Ok(object(vec![("nodes", list(nodes))]))
}

fn code_block(c: &whiteboard_scene::CodeBlockNode) -> String {
    let mut f =
        vec![("kind", string("codeBlock")), ("bbox", bbox(&c.bbox)), ("value", string(&c.value))];
    f.extend(c.lang.as_deref().map(|l| ("lang", string(l))));
    f.extend(c.runs.as_ref().map(|r| ("runs", list(r.iter().map(run)))));
    f.extend(c.appearance.as_ref().map(|a| ("appearance", appearance(a))));
    f.extend(c.radius.map(|r| ("radius", num(r))));
    object(f)
}

fn fragment(g: &whiteboard_scene::SvgFragmentNode) -> String {
    let mut f =
        vec![("kind", string("svgFragment")), ("bbox", bbox(&g.bbox)), ("svg", string(&g.svg))];
    f.extend(g.role.map(|_| ("role", string("presentation"))));
    object(f)
}
