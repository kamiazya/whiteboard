//! `wb_version_restore` over `whiteboard-ops`'s `VersionRestore`: its input
//! judged whole and every refusal answered, a restore in place answered, and
//! what the operation leaves pending answered as a pending tool.

use serde_json::{Map, Value};
use whiteboard_model::checks::canonical_ulid;
use whiteboard_ops::{VersionRestore, VersionRestoreAnswer, VersionRestoreInput};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::{Field, Input, Kind, Refined};
use super::json::Json;

/// `ID_MAX_CHARS`.
const ID_MAX: usize = 256;

/// `DOCUMENT_PATH_MAX_LENGTH`.
const PATH_MAX: usize = 1024;

/// `DOCUMENT_PATH_SEGMENT_PATTERN` on every segment.
fn path_segments(path: &str) -> bool {
    path.split('/').all(|segment| {
        let bytes = segment.as_bytes();
        let ends = |b: Option<&u8>| b.is_some_and(u8::is_ascii_alphanumeric);
        ends(bytes.first())
            && ends(bytes.last())
            && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-')
    })
}

impl Binding for VersionRestore {
    const NAME: &str = "wb_version_restore";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_version_restore.json");
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
            Field {
                name: "versionId",
                kind: Kind::RequiredBounded {
                    max: ID_MAX,
                    too_big: "a version id is longer than the 256-character limit for one id",
                },
            },
            Field {
                name: "targetPath",
                kind: Kind::Path {
                    max: PATH_MAX,
                    segments: Refined {
                        test: path_segments,
                        message: "each segment must be non-empty and contain only ASCII letters, digits and interior hyphens",
                    },
                },
            },
            Field { name: "overwrite", kind: Kind::Flag },
            Field { name: "subtree", kind: Kind::Flag },
        ],
        refine: None,
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> VersionRestoreInput {
        let text = |key: &str| arguments.get(key).and_then(Value::as_str).map(str::to_owned);
        let flag = |key: &str| arguments.get(key).and_then(Value::as_bool);
        VersionRestoreInput {
            workspace_id: workspace_id.unwrap_or_default(),
            document_id: text("documentId").unwrap_or_default(),
            version_id: text("versionId").unwrap_or_default(),
            target_path: text("targetPath"),
            overwrite: flag("overwrite"),
            subtree: flag("subtree"),
        }
    }

    /// `restoreOutput`'s in-place record: `{ ...base, mode }`.
    fn output(answer: &VersionRestoreAnswer) -> Option<Json> {
        let VersionRestoreAnswer::Restored(restored) = answer else { return None };
        let mut members = vec![
            ("documentId", Json::Text(restored.document_id.clone())),
            ("restoredVersionId", Json::Text(restored.restored_version_id.clone())),
        ];
        if let Some(label) = &restored.label {
            members.push(("label", Json::Text(label.clone())));
        }
        members.push(("mode", Json::Text("in-place".to_owned())));
        Some(Json::Object(members))
    }
}
