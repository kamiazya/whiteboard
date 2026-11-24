//! `wb_version_save` over `whiteboard-ops`'s `VersionSave`.

use serde_json::{Map, Value};
use whiteboard_model::checks::canonical_ulid;
use whiteboard_ops::{VersionSave, VersionSaveInput, VersionSaveOutput};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::{Field, Input, Kind, Refined};
use super::json::Json;
use super::version_list::version;

/// `MAX_DOCUMENTS`: a batch a caller can still read back.
const MAX_DOCUMENTS: usize = 50;

/// `VERSION_LABEL_MAX_LENGTH`.
const LABEL_MAX: usize = 200;

impl Binding for VersionSave {
    const NAME: &str = "wb_version_save";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_version_save.json");
    const INPUT: Input = Input {
        fields: &[
            WORKSPACE_ADDRESS,
            Field {
                name: "documentIds",
                kind: Kind::List {
                    min: 1,
                    max: MAX_DOCUMENTS,
                    item: Refined { test: canonical_ulid, message: "must be a canonical ULID" },
                },
            },
            Field { name: "label", kind: Kind::Sized { min: 1, max: LABEL_MAX } },
        ],
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> VersionSaveInput {
        let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
        let document_ids = arguments
            .get("documentIds")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().map(text).collect())
            .unwrap_or_default();
        let label = arguments.get("label").map(text).unwrap_or_default();
        VersionSaveInput { workspace_id: workspace_id.unwrap_or_default(), document_ids, label }
    }

    fn output(output: &VersionSaveOutput) -> Option<Json> {
        let saved = output.saved.iter().map(|saved| {
            Json::Object(vec![
                ("documentId", Json::Text(saved.document_id.clone())),
                ("version", version(&saved.version)),
            ])
        });
        Some(Json::Object(vec![("saved", Json::List(saved.collect()))]))
    }
}
