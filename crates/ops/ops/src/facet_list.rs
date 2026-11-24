//! `wb_facet_list`: what a write may name — the deployment's facets and
//! assets, filtered to one target or one asset kind.
//!
//! A facet's payload schema is served as its contract writes it, every
//! `x-wb-*` member dropped and its local references inlined (owner decision
//! q48), where the TypeScript serves `z.toJSONSchema` of the generated Zod:
//! the same constraints in another JSON Schema, which the replay declares
//! as a difference rather than reproducing.

use whiteboard_api_contracts::Refusal;
use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetTarget};
use whiteboard_facet_engine::registry::{ListedFacet, Registry};
use whiteboard_model::Value;
use whiteboard_plugin_visual::host::visual_registry;

use crate::{Contract, Operation, Ports, Row};

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

/// The facets sorted by key, the assets in registration order (themes,
/// icons, stencils), and, when a target filtered the facets, the keys it
/// filtered out by the scopes that hold them (none written when empty).
#[derive(Debug, Clone, PartialEq)]
pub struct FacetListOutput {
    pub facets: Vec<FacetEntry>,
    pub assets: Vec<AssetEntry>,
    pub other_targets: Vec<(FacetTarget, Vec<String>)>,
}

/// The listing, or `Pending` for a call naming a workspace: its own stencil
/// library, the tags it uses and its tag library are not answered yet.
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
    /// daemon refuses to boot without.
    async fn execute<P: Ports>(
        _ports: &P,
        input: FacetListInput,
    ) -> Result<FacetListAnswer, Refusal> {
        if input.workspace_id.is_some() {
            return Ok(FacetListAnswer::Pending);
        }
        let registry = visual_registry().map_err(|_| Refusal::InternalError)?;
        Ok(FacetListAnswer::Listed(listing(&registry, input.target, input.asset_kind)))
    }
}

fn listing(
    registry: &Registry,
    target: Option<FacetTarget>,
    asset_kind: Option<AssetKind>,
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
    FacetListOutput { facets, assets: assets(registry, asset_kind), other_targets }
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
