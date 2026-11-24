//! A document hosted on a workspace tree node, read as the document it is: its
//! containers copied out of the node's meta map into a standalone `LoroDoc`
//! whose roots they become. A value copy with a fresh oplog, so what is read
//! is the state the node holds now and never its history.

use crate::copy::{NodeAt, fill_map, push_all};
use crate::write::{WriteError, refused};
use loro::{
    Container, ExpandType, LoroDoc, LoroText, StyleConfig, StyleConfigMap, TextDelta,
    ValueOrContainer,
};

/// A stored plane belongs to the record, not the document: carrying one into
/// the projection would copy what the record reads separately.
const STORED_PLANE_KEY_PREFIX: &str = "plane:";

/// The standalone document the node's containers make. A scalar of the meta
/// map (segment, kind, name, documentId) is tree bookkeeping and stays behind.
/// Text keeps its marks, so a mark read from the projection is the node's own.
pub fn project_node(at: NodeAt<'_>) -> Result<LoroDoc, WriteError> {
    project_node_without(at, &[])
}

/// [`project_node`], the containers at the keys `omit` names left behind.
pub fn project_node_without(at: NodeAt<'_>, omit: &[&str]) -> Result<LoroDoc, WriteError> {
    let meta = at.doc.get_tree(at.tree).get_meta(at.node.0).map_err(refused)?;
    let out = LoroDoc::new();
    let mut bodies: Vec<(String, LoroText)> = Vec::new();
    for key in meta.keys().map(|key| key.to_string()) {
        if key.starts_with(STORED_PLANE_KEY_PREFIX) || omit.contains(&key.as_str()) {
            continue;
        }
        let Some(ValueOrContainer::Container(held)) = meta.get(&key) else { continue };
        match &held {
            Container::Map(source) => {
                fill_map(&out.get_map(key.as_str()), source)?;
            }
            Container::Text(source) => bodies.push((key, source.clone())),
            Container::List(_) | Container::MovableList(_) => {
                push_all(&out.get_movable_list(key.as_str()), &held)?;
            }
            _ => {}
        }
    }
    copy_texts(&out, &bodies)?;
    out.commit();
    Ok(out)
}

/// The texts' runs with their marks. A mark can only be written under a style
/// the document declares, so every name the runs carry is declared first; how a
/// mark expands is a question for a writer, and the copy writes nothing more.
fn copy_texts(out: &LoroDoc, bodies: &[(String, LoroText)]) -> Result<(), WriteError> {
    let mut styles = StyleConfigMap::new();
    for (_, text) in bodies {
        for run in text.to_delta() {
            let TextDelta::Insert { attributes: Some(marks), .. } = run else { continue };
            for name in marks.keys() {
                styles.insert(name.as_str().into(), StyleConfig { expand: ExpandType::None });
            }
        }
    }
    out.config_text_style(styles);
    for (key, text) in bodies {
        out.get_text(key.as_str()).apply_delta(&text.to_delta()).map_err(refused)?;
    }
    Ok(())
}
