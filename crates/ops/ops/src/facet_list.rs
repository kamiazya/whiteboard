//! `wb_facet_list`: what a write may name — the deployment's facets and
//! assets, filtered to one target or one asset kind.
//!
//! A facet's payload schema is served as `z.toJSONSchema` writes the Zod
//! generated from its contract ([`Contracts::published`]), so a model reads
//! the same bytes from either server (owner decision q136).
//!
//! [`Contracts::published`]: whiteboard_facet_engine::schema::Contracts::published

mod workspace;

use whiteboard_api_contracts::Refusal;
use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetTarget};
use whiteboard_facet_engine::registry::{ListedFacet, Registry};
use whiteboard_model::Value;
use whiteboard_plugin_visual::host::visual_registry;

use crate::record::open_record;
use crate::{Contract, Operation, Ports, Row};
pub use whiteboard_reference_graph::TagInUse;
use workspace::{Unread, Vocabulary, vocabulary};

/// The filters, and the workspace (already resolved to its canonical id)
/// whose own vocabulary is asked for too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacetListInput {
    pub target: Option<FacetTarget>,
    pub asset_kind: Option<AssetKind>,
    pub workspace_id: Option<String>,
}

/// One registered facet.
#[derive(Debug, Clone, PartialEq)]
pub struct FacetEntry {
    /// The exact key a write must use, `{namespace}.{name}/{version}`.
    pub key: String,
    pub namespace: String,
    /// The owning plugin's human-facing name.
    pub display_name: String,
    pub name: String,
    pub version: String,
    pub targets: Vec<FacetTarget>,
    pub schema: Option<Value>,
    /// Which field takes the id of which asset kind; none written when empty.
    pub asset_refs: Vec<(String, AssetKind)>,
}

/// One registered asset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetEntry {
    pub id: String,
    pub kind: AssetKind,
    /// The owning plugin's id, the id's first segment.
    pub namespace: String,
    /// What a picker calls it: a stencil's, never a theme's or an icon's.
    pub display_name: Option<String>,
}

/// One value a declared key admits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredValue {
    pub value: String,
    /// What a box or an edge carrying it is drawn in.
    pub color: Option<String>,
    pub description: Option<String>,
}

/// One key a workspace's tag library declares; `values` absent admits any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredKey {
    pub key: String,
    pub description: Option<String>,
    pub exclusive: Option<bool>,
    pub values: Option<Vec<DeclaredValue>>,
}

/// What a named workspace adds beside its stencils: the tags in use, sorted
/// by tag, and the keys its library declares, sorted by key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceTags {
    pub tags: Vec<TagInUse>,
    pub tag_library: Vec<DeclaredKey>,
}

/// The facets sorted by key, the assets in registration order (themes,
/// icons, stencils, a workspace's stencils last), and, when a target
/// filtered the facets, the keys it filtered out by the scopes that hold
/// them (none written when empty); a named workspace's tags beside them.
#[derive(Debug, Clone, PartialEq)]
pub struct FacetListOutput {
    pub facets: Vec<FacetEntry>,
    pub assets: Vec<AssetEntry>,
    pub other_targets: Vec<(FacetTarget, Vec<String>)>,
    pub workspace: Option<WorkspaceTags>,
}

/// The listing, or `Pending` for a workspace holding a read this crate does
/// not answer yet.
#[derive(Debug, Clone, PartialEq)]
pub enum FacetListAnswer {
    Listed(FacetListOutput),
    Pending,
}

/// `createFacetListTool`'s execute, which only `wb_facet_list` calls.
#[derive(Debug, Clone, Copy)]
pub struct FacetList;

impl Operation for FacetList {
    type Input = FacetListInput;
    type Output = FacetListAnswer;

    const ROW: Row = Row {
        name: "facetList",
        tool: Some("wb_facet_list"),
        route: None,
        input: Contract { schema: "facetListInputSchema" },
        output: Contract { schema: "facetListOutputSchema" },
    };

    /// The deployment's registry is the bundled visual plugin's, the one the
    /// daemon refuses to boot without. A named workspace is read from its
    /// record, which an unknown one does not have: refused, since answering
    /// the deployment's vocabulary would read as "this workspace declares
    /// none".
    async fn execute<P: Ports>(
        ports: &P,
        input: FacetListInput,
    ) -> Result<FacetListAnswer, Refusal> {
        let registry = visual_registry().map_err(|_| Refusal::InternalError)?;
        let found = match &input.workspace_id {
            None => None,
            Some(id) => {
                let record =
                    open_record(ports.records(), id).await.map_err(|e| Refusal::from(&e))?;
                match vocabulary(&record, &registry) {
                    Ok(found) => Some(found),
                    Err(Unread::Refused(refusal)) => return Err(refusal),
                    Err(Unread::Pending) => return Ok(FacetListAnswer::Pending),
                }
            }
        };
        Ok(FacetListAnswer::Listed(listing(&registry, input.target, input.asset_kind, found)))
    }
}

fn listing(
    registry: &Registry,
    target: Option<FacetTarget>,
    asset_kind: Option<AssetKind>,
    found: Option<Vocabulary>,
) -> FacetListOutput {
    let mut all: Vec<FacetEntry> = registry.listed_facets().into_iter().map(entry).collect();
    // Every key is ASCII by its grammar, so a byte order is the code-unit
    // order `compareCodeUnit` sorts by.
    all.sort_by(|a, b| a.key.cmp(&b.key));
    let other_targets = target.map_or_else(Vec::new, |target| filtered_out(&all, target));
    let facets = all
        .into_iter()
        .filter(|facet| target.is_none_or(|target| facet.targets.contains(&target)))
        .collect();
    let mut assets = assets(registry, asset_kind);
    let Some(found) = found else {
        return FacetListOutput { facets, assets, other_targets, workspace: None };
    };
    if asset_kind.is_none_or(|only| only == AssetKind::Stencils) {
        assets.extend(found.stencils);
    }
    let workspace = WorkspaceTags { tags: found.tags, tag_library: found.tag_library };
    FacetListOutput { facets, assets, other_targets, workspace: Some(workspace) }
}

fn entry(listed: ListedFacet<'_>) -> FacetEntry {
    FacetEntry {
        key: format!("{}.{}/{}", listed.namespace, listed.name, listed.version),
        namespace: listed.namespace.to_owned(),
        display_name: listed.display_name.to_owned(),
        name: listed.name.to_owned(),
        version: listed.version.to_owned(),
        targets: listed.targets.to_vec(),
        schema: listed.schema,
        asset_refs: listed.asset_refs.to_vec(),
    }
}

/// The scopes `target` removed a facet from, in the order a scope is first
/// met; a facet the filter kept is never repeated under its other scopes.
fn filtered_out(all: &[FacetEntry], target: FacetTarget) -> Vec<(FacetTarget, Vec<String>)> {
    let mut by_target: Vec<(FacetTarget, Vec<String>)> = Vec::new();
    for facet in all.iter().filter(|facet| !facet.targets.contains(&target)) {
        for other in &facet.targets {
            match by_target.iter_mut().find(|(held, _)| held == other) {
                Some((_, keys)) => keys.push(facet.key.clone()),
                None => by_target.push((*other, vec![facet.key.clone()])),
            }
        }
    }
    by_target
}

fn assets(registry: &Registry, asset_kind: Option<AssetKind>) -> Vec<AssetEntry> {
    [AssetKind::Themes, AssetKind::Icons, AssetKind::Stencils]
        .into_iter()
        .filter(|kind| asset_kind.is_none_or(|only| only == *kind))
        .flat_map(|kind| {
            registry.registered(kind).iter().map(move |id| AssetEntry {
                id: id.clone(),
                kind,
                namespace: id.split_once('.').map_or("", |(namespace, _)| namespace).to_owned(),
                display_name: registry.stencil_display_name(id).map(str::to_owned),
            })
        })
        .collect()
}
