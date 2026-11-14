//! A plugin loaded from its files: a manifest, the contracts its payload
//! schemas point into, and the asset tables its manifest names, all as the
//! JSON text they are written in (ADR-0054 decision 12, owner decision q45:
//! the files are the single source, the TypeScript imports them and the Rust
//! embeds them).
//!
//! [`build`] is the Rust counterpart of `pluginFromManifest` followed by
//! `createFacetRegistry`, for one plugin: the contracts compile, the manifest
//! is judged, every asset entry is judged by the engine's shape for its kind,
//! the registry is built, and every payload a bundled stencil carries is
//! checked against the schema of the facet it names.
//!
//! Not here yet: the editor's derived form, more than one plugin and a workspace's own stencil library.
//! The asset VALUES are judged and then dropped; the registry holds their ids.

use whiteboard_model::Value;
use whiteboard_model::json;

use crate::checks;
use crate::manifest;
use crate::plugin_manifest::{AssetKind, ManifestAssets};
use crate::registry::{BuildError, Migration, PayloadRefusal, Registry};
use crate::schema::{CompileError, Contracts, DefId, Host, Issue};
use crate::value::{entries, field};

/// What the engine's own contracts (assets and manifest) name and the host
/// supplies: the matchers of their patterns.
pub const ENGINE_HOST: Host<'static> = Host {
    matchers: &[
        ("namespaced_id", checks::namespaced_id),
        ("facet_key", checks::facet_key),
        ("hex_color", checks::hex_color),
        ("facet_segment", checks::facet_segment),
        ("version_tag", checks::version_tag),
        ("schema_ref", checks::schema_ref),
    ],
    checks: &[],
    externals: &[],
};

/// The engine's own contracts as `(path, JSON text)`, the paths being how a
/// manifest and the definitions below point at them.
#[must_use]
pub fn engine_contracts() -> [(&'static str, &'static str); 2] {
    [
        (
            "facets/engine/engine.schema.json",
            include_str!("../../../../contracts/facets/engine/engine.schema.json"),
        ),
        (
            "plugin/plugin-manifest.schema.json",
            include_str!("../../../../contracts/plugin/plugin-manifest.schema.json"),
        ),
    ]
}

/// The files of one plugin, as the JSON text they are written in.
#[derive(Debug, Clone, Copy)]
pub struct PluginSources<'a> {
    /// The manifest.
    pub manifest: &'a str,
    /// The plugin's own contracts as `(path, text)`, the engine's excepted.
    pub contracts: &'a [(&'a str, &'a str)],
    /// The asset tables as `(name the manifest gives it, text)`. A name may
    /// appear more than once: its texts are read in order as one table, and an
    /// asset in two of them is refused.
    pub tables: &'a [(&'a str, &'a str)],
    /// The compat steps the manifest names, which only code can be.
    pub migrations: &'a [(&'a str, Migration)],
}

/// Why a plugin could not be loaded.
#[derive(Debug, Clone, PartialEq)]
pub enum LoadError {
    /// A source that is not JSON the registry can read; `source` names the
    /// contract path, `manifest` or the table.
    NotJson { source: String, refusal: json::Refusal },
    /// A contract the interpreter refuses.
    Contract(CompileError),
    /// The definition a pointer names is in no loaded contract.
    MissingDefinition(String),
    /// The manifest is not a plugin manifest.
    Manifest(Vec<Issue>),
    /// The manifest names a table no source supplies.
    UnsuppliedTable(String),
    /// A table whose text is not a JSON object.
    TableNotObject(String),
    /// An asset name that is not a facet segment.
    AssetName { kind: AssetKind, name: String },
    /// An asset two sources of one table both hold.
    DuplicateAsset { kind: AssetKind, name: String },
    /// An asset the engine's shape for its kind refuses.
    Asset { kind: AssetKind, name: String, issues: Vec<Issue> },
    /// The registry cannot be built over the manifest.
    Registry(BuildError),
    /// A stencil names a facet no plugin registered.
    StencilFacetUnregistered { stencil: String, key: String },
    /// A stencil names an older version of a facet than its current one.
    StencilFacetNotCurrent { stencil: String, key: String, current: String },
    /// A stencil's payload is refused by the facet's schema.
    StencilPayloadInvalid { stencil: String, key: String, issues: Vec<Issue> },
}

/// The definition `pointer` names, for a caller that has loaded its contracts.
pub(crate) fn definition(contracts: &Contracts, pointer: &str) -> Result<DefId, LoadError> {
    contracts.resolve(pointer).ok_or_else(|| LoadError::MissingDefinition(pointer.to_owned()))
}

fn parse(source: &str, text: &str) -> Result<Value, LoadError> {
    json::parse(text).map_err(|refusal| LoadError::NotJson { source: source.to_owned(), refusal })
}

/// The shape each kind of asset entry must have, and what the manifest calls
/// the table of that kind.
const KINDS: [(AssetKind, &str); 3] = [
    (AssetKind::Themes, "facets/engine/engine.schema.json#/$defs/ThemeTokens"),
    (AssetKind::Icons, "facets/engine/engine.schema.json#/$defs/IconAsset"),
    (AssetKind::Stencils, STENCIL_ASSET),
];

/// The engine's shape of a stencil, which a workspace's own library is judged
/// by as a bundled stencil is.
pub(crate) const STENCIL_ASSET: &str = "facets/engine/engine.schema.json#/$defs/StencilAsset";

fn table_name(assets: Option<&ManifestAssets>, kind: AssetKind) -> Option<&str> {
    let tables = assets?;
    match kind {
        AssetKind::Themes => tables.themes.as_deref(),
        AssetKind::Icons => tables.icons.as_deref(),
        AssetKind::Stencils => tables.stencils.as_deref(),
    }
}

/// One kind's table: every entry judged, under its registered id
/// (`<plugin>.<name>`), in the order the sources hold them.
fn read_table(
    contracts: &Contracts,
    plugin: &str,
    (kind, pointer): (AssetKind, &str),
    name: &str,
    sources: &PluginSources<'_>,
) -> Result<Vec<(String, Value)>, LoadError> {
    let texts: Vec<&str> =
        sources.tables.iter().filter(|(table, _)| *table == name).map(|(_, text)| *text).collect();
    if texts.is_empty() {
        return Err(LoadError::UnsuppliedTable(name.to_owned()));
    }
    let mut table: Vec<(String, Value)> = Vec::new();
    for text in texts {
        let parsed = parse(name, text)?;
        let Value::Map(members) = parsed else {
            return Err(LoadError::TableNotObject(name.to_owned()));
        };
        for (asset, entry) in members {
            if !checks::facet_segment(&asset) {
                return Err(LoadError::AssetName { kind, name: asset });
            }
            let id = format!("{plugin}.{asset}");
            if table.iter().any(|(held, _)| *held == id) {
                return Err(LoadError::DuplicateAsset { kind, name: asset });
            }
            // Resolved per entry, not once: `build` always loads the engine's
            // contracts, so the missing-definition arm has no input through
            // it, and written this way it shares the arm the reader tests.
            let valid = definition(contracts, pointer).and_then(|def| {
                contracts.validate(def, &entry).map_err(|issues| LoadError::Asset {
                    kind,
                    name: asset.clone(),
                    issues,
                })
            })?;
            table.push((id, valid));
        }
    }
    Ok(table)
}

/// Loads the plugin `sources` describe, judging its contracts with `host`
/// beside [`ENGINE_HOST`].
///
/// # Errors
///
/// The first thing that stops it, in the order it is checked: a source that is
/// not JSON, a contract the interpreter refuses, a manifest that is not one, a
/// table the manifest names and nobody supplies, an asset that is misnamed,
/// duplicated or refused by its shape, a registry that cannot be built, and a
/// bundled stencil whose facet payload its facet refuses.
pub fn build(sources: &PluginSources<'_>, host: &Host<'_>) -> Result<Registry, LoadError> {
    let mut parsed: Vec<(&str, Value)> = Vec::new();
    for (path, text) in engine_contracts().iter().chain(sources.contracts) {
        parsed.push((path, parse(path, text)?));
    }
    let loaded: Vec<(&str, &Value)> = parsed.iter().map(|(path, value)| (*path, value)).collect();
    let merged = Host {
        matchers: &[ENGINE_HOST.matchers, host.matchers].concat(),
        checks: host.checks,
        externals: host.externals,
    };
    let contracts = Contracts::load(&loaded, &merged).map_err(LoadError::Contract)?;
    let manifest = manifest::read(&contracts, &parse("manifest", sources.manifest)?)?;
    let [themes_kind, icons_kind, stencils_kind] = KINDS;
    let read = |kind: (AssetKind, &str)| match table_name(manifest.assets.as_ref(), kind.0) {
        Some(name) => read_table(&contracts, &manifest.id, kind, name, sources),
        None => Ok(Vec::new()),
    };
    let (themes, icons, stencils) = (read(themes_kind)?, read(icons_kind)?, read(stencils_kind)?);
    let ids = |kind: AssetKind| -> Vec<String> {
        let table = match kind {
            AssetKind::Themes => &themes,
            AssetKind::Icons => &icons,
            AssetKind::Stencils => &stencils,
        };
        table.iter().map(|(id, _)| id.clone()).collect()
    };
    let registry =
        Registry::build(std::slice::from_ref(&manifest), contracts, ids, sources.migrations)
            .map_err(LoadError::Registry)?;
    for (id, stencil) in &stencils {
        let facets = field(stencil, "facets").map_or(&[][..], entries);
        for (key, payload) in facets {
            registry
                .check_payload(key, payload)
                .map_err(|refusal| stencil_refusal(id, key, refusal))?;
        }
    }
    Ok(registry)
}

fn stencil_refusal(id: &str, key: &str, refusal: PayloadRefusal) -> LoadError {
    let (stencil, key) = (id.to_owned(), key.to_owned());
    match refusal {
        PayloadRefusal::Unregistered => LoadError::StencilFacetUnregistered { stencil, key },
        PayloadRefusal::NotCurrent { current } => {
            LoadError::StencilFacetNotCurrent { stencil, key, current }
        }
        PayloadRefusal::Invalid(issues) => {
            LoadError::StencilPayloadInvalid { stencil, key, issues }
        }
    }
}
