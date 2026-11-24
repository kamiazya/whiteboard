//! `wb_document_list` over `whiteboard-ops`'s `DocumentList`.

use serde_json::{Map, Value};
use whiteboard_ops::{DocumentDetail, DocumentList, DocumentListInput, DocumentListOutput};

use super::Binding;
use super::input::{Field, Input, Kind, Refined};
use super::json::Json;

impl Binding for DocumentList {
    const NAME: &'static str = "wb_document_list";
    const CONTRACT: &'static str =
        include_str!("../../../../../contracts/tools/wb_document_list.json");
    const INPUT: Input = Input { fields: &[WORKSPACE_ADDRESS] };

    fn input(_: &Map<String, Value>, workspace_id: String) -> DocumentListInput {
        DocumentListInput { workspace_id }
    }

    fn output(output: &DocumentListOutput) -> Option<Json> {
        let documents = output
            .documents
            .iter()
            .map(|listed| {
                let mut members = detail(&listed.detail);
                members.push(("pinned", Json::Bool(listed.pinned)));
                Json::Object(members)
            })
            .collect();
        let mut members = vec![("documents", Json::List(documents))];
        if !output.folder_names.is_empty() {
            let names = output
                .folder_names
                .iter()
                .map(|folder| {
                    Json::Object(vec![
                        ("path", Json::Text(folder.path.clone())),
                        ("name", Json::Text(folder.name.clone())),
                    ])
                })
                .collect();
            members.push(("folderNames", Json::List(names)));
        }
        Some(Json::Object(members))
    }
}

/// A listed document's members in the order `wbDocumentList` spreads them,
/// an absent one left out.
fn detail(detail: &DocumentDetail) -> Vec<(&'static str, Json)> {
    let optional =
        [("name", &detail.name), ("kind", &detail.kind), ("updatedAt", &detail.updated_at)];
    let mut members = vec![
        ("documentId", Json::Text(detail.document_id.clone())),
        ("path", Json::Text(detail.path.clone())),
    ];
    members.extend(
        optional.into_iter().filter_map(|(key, value)| Some((key, Json::Text(value.clone()?)))),
    );
    if detail.shadowed {
        members.push(("shadowed", Json::Bool(true)));
    }
    members
}

/// `workspaceId`, as `workspaceAddressInputSchema` refines it.
pub(super) const WORKSPACE_ADDRESS: Field = Field {
    name: "workspaceId",
    kind: Kind::Text(Refined {
        test: is_workspace_address,
        message: "a workspace address is an id, <handle>/<segment>, or a segment ([a-zA-Z0-9-], at most one \"/\")",
    }),
};

/// `workspaceAddressInputSchema`'s `/^[a-zA-Z0-9-]+(\/[a-zA-Z0-9-]+)?$/`:
/// one or two non-empty parts of ASCII letters, digits and hyphens. A
/// JavaScript `$` without the `m` flag matches at the very end only, so a
/// trailing line feed is refused.
fn is_workspace_address(text: &str) -> bool {
    text.split('/').count() <= 2
        && text.split('/').all(|part| {
            !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}
