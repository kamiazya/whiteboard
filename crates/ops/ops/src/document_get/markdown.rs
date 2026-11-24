//! A markdown document read as OKF Markdown (server-core's `exportOkf`): the
//! frontmatter built from what the document stores and the name the
//! workspace gives it, and the text the codec writes from it.

use whiteboard_codec::okf::serialize_in_order;
use whiteboard_model::crdt::QueryName;
use whiteboard_model::{Map, Value};

use super::engine::{Fault, Hosted, defined};
use super::{Pending, Stop};

/// The type a body with no declared one is: what a document from before core
/// facets answers with (`BARE_BODY_TYPE`).
const BARE_BODY_TYPE: &str = "note";

/// What the export answers: the OKF text and the frontmatter it was written
/// from.
pub(super) struct Exported {
    pub(super) markdown: String,
    pub(super) frontmatter: Value,
}

/// Sets `key` as an object spread does: in place when held, last when not.
fn assign(entries: &mut Map, key: &str, value: Value) {
    match entries.iter_mut().find(|(held, _)| held == key) {
        Some((_, held)) => *held = value,
        None => entries.push((key.to_owned(), value)),
    }
}

/// `{ ...(core ?? { type }), title?, ...trust, facets }`. A JavaScript object
/// enumerates its integer-like keys first; the codec's writers apply that
/// order, so the entries stay as built.
fn frontmatter(
    core: Option<Value>,
    name: Option<&str>,
    trust: Option<Value>,
    facets: Value,
) -> Map {
    let mut entries = match core {
        Some(Value::Map(entries)) => entries,
        _ => vec![("type".to_owned(), Value::String(BARE_BODY_TYPE.to_owned()))],
    };
    if let Some(name) = name {
        assign(&mut entries, "title", Value::String(name.to_owned()));
    }
    if let Some(Value::Map(trust)) = trust {
        for (key, value) in trust {
            assign(&mut entries, &key, value);
        }
    }
    assign(&mut entries, "facets", facets);
    entries
}

/// The body the by-kind read answers for a markdown document: its own, or
/// none when the content it holds is a canvas.
fn body_of(content: Value) -> String {
    let Value::Map(entries) = content else { return String::new() };
    let Some((_, Value::Map(content))) = entries.into_iter().find(|(key, _)| key == "content")
    else {
        return String::new();
    };
    let field = |name: &str| content.iter().find(|(key, _)| key == name).map(|(_, value)| value);
    match (field("kind"), field("body")) {
        (Some(Value::String(kind)), Some(Value::String(body))) if kind == "markdown" => {
            body.clone()
        }
        _ => String::new(),
    }
}

/// The document as OKF Markdown, `name` being its display name in the
/// workspace.
pub(super) fn export(hosted: Hosted<'_>, name: Option<&str>) -> Result<Exported, Fault> {
    let kind = [("kind", Value::String("markdown".to_owned()))];
    let body = body_of(hosted.read(QueryName::DocumentContentWithTags, &kind)?);
    let core = defined(hosted.read(QueryName::CoreFacets, &[])?);
    let facets = hosted.read(QueryName::Facets, &[])?;
    let trust = defined(hosted.read(QueryName::TrustFacets, &[])?);
    let frontmatter = frontmatter(core, name, trust, facets);
    let markdown =
        serialize_in_order(frontmatter.clone(), &body).map_err(|_| unwritable(hosted))?;
    Ok(Exported { markdown, frontmatter: Value::Map(frontmatter) })
}

/// A frontmatter the codec has no spelling for: refused there as the
/// codec's own error, whose words are the TypeScript shim's, so pending.
fn unwritable(hosted: Hosted<'_>) -> Fault {
    Fault::Stop(Stop::Pending(Pending::OkfUnwritable(hosted.document_id.to_owned())))
}

#[cfg(test)]
mod tests;
