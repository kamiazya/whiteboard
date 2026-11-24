//! `wb_facet_list` over `whiteboard-ops`'s `FacetList`.

use serde_json::{Map, Value};
use whiteboard_model::Value as Plain;
use whiteboard_ops::{
    AssetEntry, AssetKind, DeclaredKey, DeclaredValue, FacetEntry, FacetList, FacetListAnswer,
    FacetListInput, FacetTarget, TagInUse,
};

use super::Binding;
use super::input::{Field, Input, Kind};
use super::json::Json;

const TARGETS: [FacetTarget; 4] =
    [FacetTarget::Document, FacetTarget::Canvas, FacetTarget::Node, FacetTarget::Edge];
const ASSET_KINDS: [AssetKind; 3] = [AssetKind::Themes, AssetKind::Icons, AssetKind::Stencils];

impl Binding for FacetList {
    const NAME: &str = "wb_facet_list";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_facet_list.json");
    const INPUT: Input = Input {
        fields: &[
            Field { name: "target", kind: Kind::Choice(&["document", "canvas", "node", "edge"]) },
            Field { name: "assetKind", kind: Kind::Choice(&["themes", "icons", "stencils"]) },
            Field { name: "workspaceId", kind: Kind::OptionalText },
        ],
        refine: None,
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> FacetListInput {
        let named = |key: &str| arguments.get(key).and_then(Value::as_str);
        FacetListInput {
            target: named("target").and_then(|t| TARGETS.into_iter().find(|k| k.as_str() == t)),
            asset_kind: named("assetKind")
                .and_then(|a| ASSET_KINDS.into_iter().find(|k| k.as_str() == a)),
            workspace_id,
        }
    }

    fn output(answer: &FacetListAnswer) -> Option<Json> {
        let FacetListAnswer::Listed(output) = answer else { return None };
        let mut members = vec![
            ("facets", Json::List(output.facets.iter().map(facet).collect())),
            ("assets", Json::List(output.assets.iter().map(asset).collect())),
        ];
        if !output.other_targets.is_empty() {
            let scopes = output
                .other_targets
                .iter()
                .map(|(target, keys)| (target.as_str(), texts(keys.iter().map(String::as_str))))
                .collect();
            members.push(("otherTargets", Json::Object(scopes)));
        }
        if let Some(workspace) = &output.workspace {
            members.push(("tags", Json::List(workspace.tags.iter().map(tag_in_use).collect())));
            let keys = workspace.tag_library.iter().map(declared_key).collect();
            members.push(("tagLibrary", Json::List(keys)));
        }
        Some(Json::Object(members))
    }
}

fn texts<'a>(items: impl Iterator<Item = &'a str>) -> Json {
    Json::List(items.map(|item| Json::Text(item.to_owned())).collect())
}

/// A facet's members in the order `createFacetListTool` builds them, an
/// absent schema and an empty `assetRefs` left out.
fn facet(entry: &FacetEntry) -> Json {
    let text = |value: &str| Json::Text(value.to_owned());
    let mut members = vec![
        ("key", text(&entry.key)),
        ("namespace", text(&entry.namespace)),
        ("displayName", text(&entry.display_name)),
        ("name", text(&entry.name)),
        ("version", text(&entry.version)),
        ("targets", texts(entry.targets.iter().map(|target| target.as_str()))),
    ];
    members.extend(entry.schema.clone().map(|schema| ("schema", Json::Plain(schema))));
    if !entry.asset_refs.is_empty() {
        let refs =
            entry.asset_refs.iter().map(|(field, kind)| (field.clone(), text(kind.as_str())));
        members.push(("assetRefs", Json::Fields(refs.collect())));
    }
    Json::Object(members)
}

fn asset(entry: &AssetEntry) -> Json {
    let mut members = vec![
        ("id", Json::Text(entry.id.clone())),
        ("kind", Json::Text(entry.kind.as_str().to_owned())),
        ("namespace", Json::Text(entry.namespace.clone())),
    ];
    members.extend(entry.display_name.clone().map(|name| ("displayName", Json::Text(name))));
    Json::Object(members)
}

/// A tag in use in `tagsInUse`'s member order, a plain tag without halves.
fn tag_in_use(row: &TagInUse) -> Json {
    let count = |n: u32| Json::Plain(Plain::Number(f64::from(n)));
    let mut members = vec![("tag", Json::Text(row.tag.clone()))];
    if let Some((key, value)) = &row.scoped {
        members.push(("key", Json::Text(key.clone())));
        members.push(("value", Json::Text(value.clone())));
    }
    members.extend([
        ("documents", count(row.documents)),
        ("boards", count(row.boards)),
        ("nodes", count(row.nodes)),
        ("edges", count(row.edges)),
    ]);
    Json::Object(members)
}

/// What a declared key or value leaves undeclared is left out.
fn declared_key(key: &DeclaredKey) -> Json {
    let mut members = vec![("key", Json::Text(key.key.clone()))];
    members.extend(key.description.clone().map(|text| ("description", Json::Text(text))));
    members.extend(key.exclusive.map(|flag| ("exclusive", Json::Bool(flag))));
    if let Some(values) = &key.values {
        members.push(("values", Json::List(values.iter().map(declared_value).collect())));
    }
    Json::Object(members)
}

fn declared_value(value: &DeclaredValue) -> Json {
    let mut members = vec![("value", Json::Text(value.value.clone()))];
    members.extend(value.color.clone().map(|color| ("color", Json::Text(color))));
    members.extend(value.description.clone().map(|text| ("description", Json::Text(text))));
    Json::Object(members)
}
