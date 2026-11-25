//! A facets bucket judged for the write it is part of, and a refusal worded
//! as every agent write path words it.

use whiteboard_api_contracts::Refusal;
use whiteboard_facet_engine::partition::{self, Refused, Writes};
use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetTarget};
use whiteboard_facet_engine::registry::{Registry, WriteRefusal};
use whiteboard_facet_engine::schema::{Code, Issue, PathStep};
use whiteboard_model::Value;

/// Whether a bucket writes a facet that takes a stencil: the one question a
/// workspace's stencil library is read for, which this crate does not answer
/// yet. Which facets take one is asked of the registry, since that is a
/// plugin's declaration and not this crate's.
pub(super) fn writes_a_stencil(registry: &Registry, bucket: &[(String, Value)]) -> bool {
    bucket.iter().any(|(key, payload)| {
        *payload != Value::Null
            && registry
                .asset_refs_of(key)
                .is_some_and(|refs| refs.iter().any(|(_, kind)| *kind == AssetKind::Stencils))
    })
}

/// The bucket as the sets and deletions it stands for, or the refusal its
/// first refused key stands for.
pub(super) fn judge(
    registry: &Registry,
    target: FacetTarget,
    bucket: &[(String, Value)],
) -> Result<Writes, Refusal> {
    partition::partition(registry, &[], target, bucket).map_err(|refused| {
        let reason = sentence_of(&refused, target);
        Refusal::FacetWriteRejected { facet_key: refused.key, reason }
    })
}

/// "an edge", "a node": the refusal names the object, so it has to read like
/// one.
const fn article(target: FacetTarget) -> &'static str {
    match target {
        FacetTarget::Edge => "an",
        _ => "a",
    }
}

fn sentence_of(refused: &Refused, target: FacetTarget) -> String {
    let key = &refused.key;
    match &refused.why {
        partition::Refusal::Target(targets) => {
            let held: Vec<&str> = targets.iter().map(|held| held.as_str()).collect();
            format!(
                "its targets are [{}], and this write targets {} {}",
                held.join(", "),
                article(target),
                target.as_str()
            )
        }
        partition::Refusal::Write(why) => write_sentence(key, why),
        partition::Refusal::Unrecognized(stray) => {
            let place =
                if stray.path.is_empty() { "payload".to_owned() } else { stray.path.join(".") };
            format!(
                "payload for \"{key}\" is invalid: {place}: Unrecognized key: \"{}\"",
                stray.key
            )
        }
    }
}

fn write_sentence(key: &str, why: &WriteRefusal) -> String {
    match why {
        WriteRefusal::MalformedKey => format!("malformed facet key \"{key}\""),
        WriteRefusal::NotCurrentVersion { current } => {
            format!("\"{key}\" is not the current version \u{2014} write \"{current}\"")
        }
        WriteRefusal::Invalid(issues) => {
            format!("payload for \"{key}\" is invalid: {}", issue_list(issues))
        }
        WriteRefusal::UnregisteredAsset { field, id, kind, registered } => {
            let held =
                if registered.is_empty() { "(none)".to_owned() } else { registered.join(", ") };
            format!(
                "\"{key}\" field {field} names {} asset \"{id}\", which no plugin registered \u{2014} registered: {held}",
                kind.as_str()
            )
        }
    }
}

/// Each issue by its place and code, not in Zod's words.
fn issue_list(issues: &[Issue]) -> String {
    let each = |issue: &Issue| {
        let steps: Vec<String> = issue
            .path
            .iter()
            .map(|step| match step {
                PathStep::Key(name) => name.clone(),
                PathStep::Index(at) => at.to_string(),
            })
            .collect();
        let place = if steps.is_empty() { "(payload)".to_owned() } else { steps.join(".") };
        format!("{place}: {}", code_name(issue.code))
    };
    issues.iter().map(each).collect::<Vec<_>>().join("; ")
}

const fn code_name(code: Code) -> &'static str {
    match code {
        Code::InvalidType => "invalid_type",
        Code::TooSmall => "too_small",
        Code::TooBig => "too_big",
        Code::InvalidFormat => "invalid_format",
        Code::InvalidValue => "invalid_value",
        Code::UnrecognizedKeys => "unrecognized_keys",
        Code::InvalidUnion => "invalid_union",
        Code::InvalidKey => "invalid_key",
        Code::Custom => "custom",
    }
}

#[cfg(test)]
mod tests;
