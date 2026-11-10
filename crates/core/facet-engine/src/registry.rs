//! The facet registry (ADR-0013 decisions 3, 6, 7) over plugin manifests: what
//! each facet is called, where it attaches, which asset ids its payload may
//! name, and the one write check, which judges a payload by the contract the
//! facet's manifest points at (owner decision q41) and refuses as the
//! TypeScript registry's `validateFacetWrite` does, stage by stage.

use whiteboard_model::Value;

use crate::checks;
use crate::plugin_manifest::{AssetKind, FacetTarget, PluginManifest};
use crate::schema::{Contracts, DefId, Issue};

/// The plugin id the engine keeps for a workspace's own stencil library.
pub const WORKSPACE_PLUGIN_ID: &str = "workspace";

/// Why a registry cannot be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildError {
    DuplicatePlugin(String),
    ReservedPlugin(String),
    DuplicateFacet {
        plugin: String,
        facet: String,
    },
    /// A facet's `schema` pointer that no loaded contract holds.
    UnresolvedSchema {
        plugin: String,
        facet: String,
        pointer: String,
    },
    /// An `assetRefs` field the facet's payload schema does not declare.
    UndeclaredAssetField {
        plugin: String,
        facet: String,
        field: String,
    },
}

/// Why a write is refused, by the stage that refused it.
#[derive(Debug, Clone, PartialEq)]
pub enum WriteRefusal {
    /// The key is not `<plugin>.<name>/v<n>`.
    MalformedKey,
    /// Writes target the current version; an older one exists only to be read.
    NotCurrentVersion { current: String },
    /// The payload's schema refuses it.
    Invalid(Vec<Issue>),
    /// A field names an asset no plugin registered.
    UnregisteredAsset { field: String, id: String, kind: AssetKind, registered: Vec<String> },
}

struct FacetEntry {
    namespace: String,
    name: String,
    version: String,
    targets: Vec<FacetTarget>,
    schema: DefId,
    asset_refs: Vec<(String, AssetKind)>,
}

/// The facets the loaded plugins declare, and the asset ids the host holds.
pub struct Registry {
    contracts: Contracts,
    facets: Vec<FacetEntry>,
    assets: Vec<(AssetKind, Vec<String>)>,
}

const KINDS: [AssetKind; 3] = [AssetKind::Themes, AssetKind::Icons, AssetKind::Stencils];

impl Registry {
    /// Builds the registry of `manifests`, whose facets' payload schemas are
    /// definitions of `contracts`. `asset_ids` answers which asset ids of a
    /// kind are registered, in registration order.
    ///
    /// # Errors
    ///
    /// The first manifest that cannot be registered: a duplicate or reserved
    /// plugin id, a duplicate facet name, a schema pointer no contract holds,
    /// or an `assetRefs` field the payload schema does not declare.
    pub fn build(
        manifests: &[PluginManifest],
        contracts: Contracts,
        asset_ids: impl Fn(AssetKind) -> Vec<String>,
    ) -> Result<Self, BuildError> {
        let mut facets: Vec<FacetEntry> = Vec::new();
        for (index, manifest) in manifests.iter().enumerate() {
            let plugin = &manifest.id;
            if plugin == WORKSPACE_PLUGIN_ID {
                return Err(BuildError::ReservedPlugin(plugin.clone()));
            }
            if manifests.iter().take(index).any(|earlier| earlier.id == *plugin) {
                return Err(BuildError::DuplicatePlugin(plugin.clone()));
            }
            for decl in &manifest.facets {
                let facet = decl.name.clone();
                if facets.iter().any(|f| f.namespace == *plugin && f.name == facet) {
                    return Err(BuildError::DuplicateFacet { plugin: plugin.clone(), facet });
                }
                let schema = contracts.resolve(&decl.schema).ok_or_else(|| {
                    BuildError::UnresolvedSchema {
                        plugin: plugin.clone(),
                        facet: facet.clone(),
                        pointer: decl.schema.clone(),
                    }
                })?;
                let refs = decl.asset_refs.as_deref().unwrap_or_default();
                if let Some((field, _)) =
                    refs.iter().find(|(field, _)| !contracts.declares(schema, field))
                {
                    return Err(BuildError::UndeclaredAssetField {
                        plugin: plugin.clone(),
                        facet,
                        field: field.clone(),
                    });
                }
                facets.push(FacetEntry {
                    namespace: plugin.clone(),
                    name: decl.name.clone(),
                    version: decl.version.clone(),
                    targets: decl.targets.clone(),
                    schema,
                    asset_refs: refs.to_vec(),
                });
            }
        }
        let assets = KINDS.map(|kind| (kind, asset_ids(kind))).to_vec();
        Ok(Self { contracts, facets, assets })
    }

    /// The facet a well-formed key names, whatever version it asks for, and
    /// the version it asks for.
    fn entry<'k>(&self, key: &'k str) -> Option<(&FacetEntry, &'k str)> {
        if !checks::facet_key(key) {
            return None;
        }
        // A key that matched the grammar has its `.` and its `/`.
        let (namespace, rest) = key.split_once('.').unwrap_or_default();
        let (name, version) = rest.split_once('/').unwrap_or_default();
        let found = self.facets.iter().find(|f| f.namespace == namespace && f.name == name);
        found.map(|facet| (facet, version))
    }

    /// Where a facet may attach, for any version of a registered facet.
    #[must_use]
    pub fn targets_of(&self, key: &str) -> Option<&[FacetTarget]> {
        self.entry(key).map(|(facet, _)| facet.targets.as_slice())
    }

    /// Which asset kind each asset-naming field of a registered facet holds,
    /// in the order its manifest declares them.
    #[must_use]
    pub fn asset_refs_of(&self, key: &str) -> Option<&[(String, AssetKind)]> {
        self.entry(key).map(|(facet, _)| facet.asset_refs.as_slice())
    }

    fn registered(&self, kind: AssetKind) -> &[String] {
        self.assets.iter().find(|(known, _)| *known == kind).map_or(&[], |(_, ids)| ids.as_slice())
    }

    /// What a write of `payload` under `key` stores: the payload as its
    /// schema parses it (unknown keys stripped, defaults filled, keys in the
    /// schema's order), or the stage that refused it. A key no plugin
    /// registered is someone else's facet and is stored as it came.
    ///
    /// # Errors
    ///
    /// The first stage to refuse, in the order the TypeScript registry checks
    /// them: the key's grammar, its version, the payload's schema, and last
    /// that every asset id it names is registered.
    pub fn validate_facet_write(&self, key: &str, payload: &Value) -> Result<Value, WriteRefusal> {
        if !checks::facet_key(key) {
            return Err(WriteRefusal::MalformedKey);
        }
        let Some((facet, version)) = self.entry(key) else { return Ok(payload.clone()) };
        if version != facet.version {
            let current = format!("{}.{}/{}", facet.namespace, facet.name, facet.version);
            return Err(WriteRefusal::NotCurrentVersion { current });
        }
        let value =
            self.contracts.validate(facet.schema, payload).map_err(WriteRefusal::Invalid)?;
        self.unregistered_ref(facet, &value).map_or(Ok(value), Err)
    }

    /// The first asset-naming field, in declaration order, holding an id no
    /// plugin registered. A field that is absent or not a string names nothing.
    fn unregistered_ref(&self, facet: &FacetEntry, value: &Value) -> Option<WriteRefusal> {
        let Value::Map(entries) = value else { return None };
        facet.asset_refs.iter().find_map(|(field, kind)| {
            let found = entries.iter().find(|(name, _)| name == field);
            let Some((_, Value::String(id))) = found else { return None };
            let registered = self.registered(*kind);
            (!registered.contains(id)).then(|| WriteRefusal::UnregisteredAsset {
                field: field.clone(),
                id: id.clone(),
                kind: *kind,
                registered: registered.to_vec(),
            })
        })
    }
}
