//! A model mdast tree as the TypeScript recorded it (JSON), read into the
//! crate's own type. Only what the typesetter has ported is read; a node type
//! it has not is an error naming it.

use serde_json::Value;
use whiteboard_model::mdast::{Flow, Phrasing, ReferenceType, Root};

type Read<T> = Result<T, String>;

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn required(v: &Value, key: &str) -> Read<String> {
    text(v, key).ok_or_else(|| format!("no {key} in {v}"))
}

fn kids(v: &Value) -> Read<Vec<Phrasing>> {
    let children = v.get("children").and_then(Value::as_array);
    children.map_or_else(|| Ok(Vec::new()), |c| c.iter().map(phrasing).collect())
}

fn reference_type(v: &Value) -> Read<ReferenceType> {
    Ok(match required(v, "referenceType")?.as_str() {
        "shortcut" => ReferenceType::Shortcut,
        "collapsed" => ReferenceType::Collapsed,
        _ => ReferenceType::Full,
    })
}

fn phrasing(v: &Value) -> Read<Phrasing> {
    Ok(match required(v, "type")?.as_str() {
        "text" => Phrasing::Text { value: required(v, "value")? },
        "emphasis" => Phrasing::Emphasis { children: kids(v)? },
        "strong" => Phrasing::Strong { children: kids(v)? },
        "delete" => Phrasing::Delete { children: kids(v)? },
        "inlineCode" => Phrasing::InlineCode { value: required(v, "value")? },
        "inlineMath" => Phrasing::InlineMath { value: required(v, "value")? },
        "break" => Phrasing::Break,
        "html" => Phrasing::Html { value: required(v, "value")? },
        "link" => {
            Phrasing::Link { url: required(v, "url")?, title: text(v, "title"), children: kids(v)? }
        }
        "image" => Phrasing::Image {
            url: required(v, "url")?,
            title: text(v, "title"),
            alt: text(v, "alt"),
        },
        "linkReference" => Phrasing::LinkReference {
            identifier: required(v, "identifier")?,
            label: text(v, "label"),
            reference_type: reference_type(v)?,
            children: kids(v)?,
        },
        "imageReference" => Phrasing::ImageReference {
            identifier: required(v, "identifier")?,
            label: text(v, "label"),
            reference_type: reference_type(v)?,
            alt: text(v, "alt"),
        },
        "wikiLink" => Phrasing::WikiLink {
            document_id: required(v, "documentId")?,
            alias: text(v, "alias"),
            fragment: text(v, "fragment"),
        },
        "embed" => Phrasing::Embed {
            document_id: required(v, "documentId")?,
            fragment: text(v, "fragment"),
        },
        other => return Err(format!("phrasing {other}")),
    })
}

fn flow(v: &Value) -> Read<Flow> {
    Ok(match required(v, "type")?.as_str() {
        "paragraph" => Flow::Paragraph { children: kids(v)? },
        "heading" => {
            let depth = v.get("depth").and_then(Value::as_u64).and_then(|d| u8::try_from(d).ok());
            Flow::Heading { depth: depth.ok_or("a heading depth")?, children: kids(v)? }
        }
        other => return Err(format!("flow {other}")),
    })
}

pub(crate) fn root(v: &Value) -> Read<Root> {
    let children = v.get("children").and_then(Value::as_array);
    let children = children.map_or_else(|| Ok(Vec::new()), |c| c.iter().map(flow).collect())?;
    Ok(Root { children })
}
