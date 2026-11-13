//! A plugin manifest read from the value its JSON file holds: judged by the
//! `PluginManifest` definition of `contracts/plugin`, then decoded into the
//! generated [`PluginManifest`].
//!
//! The registry reads what a facet is called, where it attaches, which payload
//! schema judges it, which fields name assets and which older versions it still
//! reads, so that is what is decoded. The editor is the derived form's (`editor`
//! stays `None`); it joins when that is ported.

use whiteboard_model::Value;

use crate::plugin::{LoadError, definition};
use crate::plugin_manifest::{
    AssetKind, CompatEntry, FacetDecl, FacetTarget, ManifestAssets, PluginManifest,
};
use crate::schema::Contracts;
use crate::value::{entries, field, items, text};

/// The definition a manifest is judged by.
const MANIFEST: &str = "plugin/plugin-manifest.schema.json#/$defs/PluginManifest";

/// Reads `value` as a plugin manifest, `contracts` holding the plugin
/// manifest contract.
///
/// # Errors
///
/// [`LoadError::MissingDefinition`] when `contracts` does not hold the
/// manifest definition, and [`LoadError::Manifest`] with every issue when the
/// value is not a manifest.
pub fn read(contracts: &Contracts, value: &Value) -> Result<PluginManifest, LoadError> {
    let def = definition(contracts, MANIFEST)?;
    let valid = contracts.validate(def, value).map_err(LoadError::Manifest)?;
    Ok(PluginManifest {
        id: field(&valid, "id").map(text).unwrap_or_default(),
        display_name: field(&valid, "displayName").map(text).unwrap_or_default(),
        facets: items(field(&valid, "facets")).iter().map(facet).collect(),
        assets: field(&valid, "assets").map(assets),
    })
}

fn facet(decl: &Value) -> FacetDecl {
    let named = |key: &str| field(decl, key).map(text).unwrap_or_default();
    let targets = items(field(decl, "targets"));
    FacetDecl {
        name: named("name"),
        display_name: named("displayName"),
        version: named("version"),
        targets: targets.iter().filter_map(|t| FacetTarget::from_wire(&text(t))).collect(),
        schema: named("schema"),
        asset_refs: field(decl, "assetRefs").map(|refs| {
            entries(refs)
                .iter()
                .filter_map(|(name, kind)| {
                    AssetKind::from_wire(&text(kind)).map(|kind| (name.clone(), kind))
                })
                .collect()
        }),
        editor: None,
        compat: field(decl, "compat").map(|entries_of| {
            entries(entries_of)
                .iter()
                .map(|(tag, entry)| {
                    let named = |key: &str| field(entry, key).map(text).unwrap_or_default();
                    (
                        tag.clone(),
                        CompatEntry { schema: named("schema"), migrate: named("migrate") },
                    )
                })
                .collect()
        }),
    }
}

fn assets(tables: &Value) -> ManifestAssets {
    let table = |key: &str| field(tables, key).map(text);
    ManifestAssets { themes: table("themes"), icons: table("icons"), stencils: table("stencils") }
}
