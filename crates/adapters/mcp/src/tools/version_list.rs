//! `wb_version_list` over `whiteboard-ops`'s `VersionList`.

use serde_json::{Map, Value};
use whiteboard_model::checks::canonical_ulid;
use whiteboard_ops::{VersionList, VersionListInput, VersionListOutput};
use whiteboard_ports::{OperatorKind, SavedVersion, VersionOperator};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::{Field, Input, Kind, Refined};
use super::json::Json;

impl Binding for VersionList {
    const NAME: &str = "wb_version_list";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_version_list.json");
    const INPUT: Input = Input {
        fields: &[
            WORKSPACE_ADDRESS,
            Field {
                name: "documentId",
                kind: Kind::Text(Refined {
                    test: canonical_ulid,
                    message: "must be a canonical ULID",
                }),
            },
        ],
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> VersionListInput {
        let workspace_id = workspace_id.unwrap_or_default();
        let document_id =
            arguments.get("documentId").and_then(Value::as_str).unwrap_or_default().to_owned();
        VersionListInput { workspace_id, document_id }
    }

    fn output(output: &VersionListOutput) -> Option<Json> {
        Some(Json::Object(vec![
            ("documentId", Json::Text(output.document_id.clone())),
            ("versions", Json::List(output.versions.iter().map(version).collect())),
        ]))
    }
}

/// A version in the order `versionEntryForAgent` builds it, an absent field
/// left out.
pub(super) fn version(saved: &SavedVersion) -> Json {
    let text = |value: &str| Json::Text(value.to_owned());
    let mut members = vec![("id", text(&saved.id)), ("createdAt", text(&saved.created_at))];
    members.extend(saved.label.as_deref().map(|label| ("label", text(label))));
    members.push(("auto", Json::Bool(saved.auto)));
    members.extend(saved.operator.as_ref().map(|operator| ("operator", operator_of(operator))));
    members.extend(saved.restored_from.as_deref().map(|from| ("restoredFrom", text(from))));
    Json::Object(members)
}

fn operator_of(operator: &VersionOperator) -> Json {
    let kind = match operator.kind {
        OperatorKind::Ai => "ai",
        OperatorKind::Human => "human",
        OperatorKind::System => "system",
    };
    let mut members = vec![("kind", Json::Text(kind.to_owned()))];
    members.extend(
        operator.display_name.as_deref().map(|name| ("displayName", Json::Text(name.to_owned()))),
    );
    Json::Object(members)
}
