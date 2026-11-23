//! A shape an older version stored and no reader serves, written by the
//! history (`sync-retired-shape-limits.ts`): read at each place an op
//! inserted into — a map key, or a list — through the same recognisers the
//! readers refuse with, on the document that place belongs to, whether that
//! is the root of its own record or a workspace tree node.

use super::breach::{BreachShape, TextBreach, count, text};
use super::place::{Place, map_at, place_of, roots, value_at};
use crate::content::{retired_edge_shape, retired_node_shape};
use loro::{Container, ContainerID, LoroDoc, LoroMap, LoroValue, ValueOrContainer};

const RETIRED_BODY_NODE_ID: &str = "okf-body";
const EXTENSION_KEY: &str = "x-whiteboard";

/// One place the history inserted into: a map key, or (`None`) a list.
pub(super) struct Suspect {
    pub container: ContainerID,
    pub key: Option<String>,
}

/// The document a content container belongs to: its own record's roots, or
/// a tree node's meta map. Everything here peeks; nothing is opened.
enum Host {
    Root,
    Node(LoroMap),
}

impl Host {
    fn of(doc: &LoroDoc, place: &Place) -> Option<Self> {
        if place.len() == 1 {
            return Some(Self::Root);
        }
        map_at(doc, place.id(1)?).map(Self::Node)
    }

    fn peek(&self, doc: &LoroDoc, key: &str) -> Option<Container> {
        match self {
            Self::Root => {
                let (_, id) = roots(doc).into_iter().find(|(name, _)| name == key)?;
                doc.get_container(id)
            }
            Self::Node(meta) => match meta.get(key)? {
                ValueOrContainer::Container(held) => Some(held),
                ValueOrContainer::Value(_) => None,
            },
        }
    }

    fn peek_map(&self, doc: &LoroDoc, key: &str) -> Option<LoroMap> {
        match self.peek(doc, key)? {
            Container::Map(map) => Some(map),
            _ => None,
        }
    }

    /// The kind the document's envelope states, when it states one.
    fn stated_kind(&self, doc: &LoroDoc) -> Option<String> {
        kind_of(value_at(&self.peek_map(doc, "document")?, "kind"))
    }

    fn body_len(&self, doc: &LoroDoc) -> usize {
        match self.peek(doc, "body") {
            Some(Container::Text(body)) => body.len_utf16(),
            _ => 0,
        }
    }

    fn list_len(&self, doc: &LoroDoc, key: &str) -> Option<usize> {
        match self.peek(doc, key)? {
            Container::List(list) => Some(list.len()),
            Container::MovableList(list) => Some(list.len()),
            _ => None,
        }
    }
}

/// A document kind this build knows, `None` for anything else.
fn kind_of(value: Option<LoroValue>) -> Option<String> {
    match value? {
        LoroValue::String(kind) if ["spatial", "markdown"].contains(&kind.as_str()) => {
            Some(kind.to_string())
        }
        _ => None,
    }
}

/// Whether the document is spatial: its envelope first, then, for a tree
/// node, the kind the node's meta records.
fn is_spatial(doc: &LoroDoc, host: &Host) -> bool {
    if let Some(kind) = host.stated_kind(doc) {
        return kind == "spatial";
    }
    match host {
        Host::Root => false,
        Host::Node(meta) => kind_of(value_at(meta, "kind")).as_deref() == Some("spatial"),
    }
}

/// What the map key `key` of the content map `family` holds that is retired.
fn read_key(
    doc: &LoroDoc,
    family: &str,
    key: &str,
    map: &LoroMap,
    place: &Place,
) -> Option<String> {
    let held = map.get(key);
    let value = held.as_ref().and_then(|held| match held {
        ValueOrContainer::Value(value) => Some(value.clone()),
        ValueOrContainer::Container(_) => None,
    });
    match family {
        "nodes" => {
            if let Some(found) = retired_node_shape(key, value.as_ref()) {
                return Some(found);
            }
            if key != RETIRED_BODY_NODE_ID || held.is_none() {
                return None;
            }
            // The `okf-body` node a markdown body was stored as: only an empty
            // body can hide one, and on a spatial document it is content.
            let host = Host::of(doc, place)?;
            (!is_spatial(doc, &host) && host.body_len(doc) == 0).then(|| {
                format!("a markdown body stored as the `{RETIRED_BODY_NODE_ID}` canvas text node")
            })
        }
        "edges" => retired_edge_shape(key, value.as_ref()),
        "canvas" => (key == EXTENSION_KEY && held.is_some()).then(|| {
            format!("canvas settings stored under the pre-ADR-0037 `{EXTENSION_KEY}` key")
        }),
        "comments" => {
            held.is_some().then(|| format!("a comment \"{key}\" in the flat comments plane"))
        }
        _ => None,
    }
}

/// The retired Excalidraw list the document holds, when it holds entries.
fn retired_elements(doc: &LoroDoc, place: &Place) -> Option<String> {
    let entries = Host::of(doc, place)?.list_len(doc, "elements")?;
    (entries > 0).then(|| {
        format!(
            "canvas elements stored as the retired Excalidraw `elements` list ({entries} entries)"
        )
    })
}

/// What `suspect` holds that is retired, with the rows of the map it is in.
fn read(doc: &LoroDoc, suspect: &Suspect) -> Option<(String, usize, Place)> {
    let place = place_of(doc, &suspect.container)?;
    if !place.is_content() {
        return None;
    }
    let family = place.key_back(1)?.to_owned();
    // A suspect with no key is a list an op inserted into.
    let Some(key) = &suspect.key else {
        return if family == "elements" {
            Some((retired_elements(doc, &place)?, 0, place))
        } else {
            None
        };
    };
    let map = map_at(doc, &suspect.container)?;
    let found = read_key(doc, &family, key, &map, &place)?;
    Some((found, map.len(), place))
}

/// The first place the history wrote that the state leaves holding a retired shape.
pub(super) fn retired_breach(doc: &LoroDoc, suspects: &[Suspect]) -> Option<TextBreach> {
    suspects.iter().find_map(|suspect| {
        let (found, rows, place) = read(doc, suspect)?;
        let container = text(&suspect.container.to_string());
        Some(if place.key_back(1) == Some("comments") {
            TextBreach::new(
                BreachShape::RetiredCommentPlane,
                vec![("rows", count(rows)), ("container", container)],
            )
        } else {
            TextBreach::new(
                BreachShape::RetiredShape,
                vec![("found", text(&found)), ("container", container)],
            )
        })
    })
}
