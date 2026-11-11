//! `partitionFacetWrites` and the stencil library's refusal over the wire
//! (ADR-0054 step 6), in one call: a facets bucket judged for a write against
//! the bundled plugin's registry, as every agent write path asks it.
//!
//! The host passes what the write targets, the bucket and the workspace's
//! stored stencil library, the last two in the value wire of
//! [`crate::okf_wire`] (a mapping in the order the host enumerates it, every
//! number as its 64 bits). The answer is one JSON text whose first element
//! names the outcome:
//!
//! - `["ok", sets, deletions]`: the payloads as their schemas parsed them, a
//!   mapping in the bucket's order, and a sequence of the keys it deletes.
//! - `["refused", key, stage, ...]`: the first key refused and the stage, with
//!   what that stage says: `target` the targets the facet has, `malformed-key`
//!   nothing, `not-current` the current key, `invalid` the issues, `unregistered-asset`
//!   the field, the id, the kind and the ids registered, `unrecognized-key`
//!   the path and the key, and `library` the stencils of the written library
//!   the registry would drop. An issue is `[path, code, detail]` with the
//!   detail `null`, `["keys", keys]`, `["arms", [issues, ...]]` or `["key",
//!   issues]`. The sentences are the host's to word: the core agrees with the
//!   TypeScript on where and why a payload is refused, in order, and not on
//!   what Zod calls it.
//! - `["declined", code, class]` for input the core does not answer (past its
//!   bytes, values or depth, or no wire), which the
//!   host answers from the TypeScript.
//!
//! The library is judged the way the server composes it: each stored stencil
//! on its own, the refused ones dropped, the kept ones registered as
//! `workspace.<name>` for this call. The refusal of a library the bucket
//! WRITES comes after every key has passed, as the server asks it.

use crate::input_caps::FACET_BUCKET_CHECK;
use crate::okf_wire::{json_value, value_json};
use serde_json::{Value as Json, json};
use std::sync::OnceLock;
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_facet_engine::partition::{Refusal, Refused, Writes, compose_library, partition};
use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetTarget};
use whiteboard_facet_engine::registry::{PayloadRefusal, Registry, StencilRefusal, WriteRefusal};
use whiteboard_facet_engine::schema::{Code, Detail, Issue, PathStep};
use whiteboard_model::{Map, Value, enumeration_order};
use whiteboard_plugin_visual::host::visual_registry;

/// The facet whose payload is a workspace's stencil library: a plugin's own
/// declaration, spelt here because the write path is where a library is
/// refused with its author present.
const STENCILS_KEY: &str = "visual.stencils/v0";

const TOO_LARGE: (&str, &str) = ("input-too-large", "too-large");
const TOO_DEEP: (&str, &str) = ("malformed", "too-deep");
const TOO_MANY: (&str, &str) = ("input-too-large", "too-many");
const BAD_WIRE: (&str, &str) = ("malformed", "wire");

/// A call the core does not answer, with the refusal code and the class of
/// input that earned it.
type Declined = (&'static str, &'static str);

fn declined((code, class): Declined) -> Json {
    json!(["declined", code, class])
}

/// The bundled plugin's registry, built once: loading it parses the plugin's
/// files and compiles its contracts.
fn registry() -> Option<&'static Registry> {
    static REGISTRY: OnceLock<Option<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| visual_registry().ok()).as_ref()
}

/// A bucket judged for a write targeting `target` (`document`, `canvas`, `node`
/// or `edge`), with the stencils of the workspace's stored `library` (a
/// mapping of bare name to stencil, `["m"]` for none) registered for the call.
///
/// In: `bucket` is a mapping of facet key to payload, a null payload deleting
/// its key. Out: see the module.
#[wasm_bindgen]
#[must_use]
pub fn facet_bucket_check(target: &str, bucket: &str, library: &str) -> String {
    checked(target, bucket, library).to_string()
}

fn checked(target: &str, bucket: &str, library: &str) -> Json {
    if bucket.len().saturating_add(library.len()) > FACET_BUCKET_CHECK.max_bytes {
        return declined(TOO_LARGE);
    }
    let Some(target) = FacetTarget::from_wire(target) else { return declined(BAD_WIRE) };
    let ((bucket, held), (library, stored)) = match (mapping(bucket), mapping(library)) {
        (Ok(bucket), Ok(library)) => (bucket, library),
        (Err(why), _) | (_, Err(why)) => return declined(why),
    };
    if held.saturating_add(stored) > FACET_BUCKET_CHECK.max_nodes.unwrap_or(usize::MAX) {
        return declined(TOO_MANY);
    }
    registry().map_or_else(
        || declined(BAD_WIRE),
        |registry| answered(registry, target, &bucket, &library),
    )
}

/// The mapping a wire text stands for, how many values it holds, or why the
/// core does not read it.
fn mapping(text: &str) -> Result<(Map, usize), Declined> {
    let value = serde_json::from_str::<Json>(text).ok().as_ref().and_then(json_value);
    let Some(Value::Map(entries)) = value else { return Err(BAD_WIRE) };
    let size = within(entries.iter().map(|(_, item)| item));
    if size.depth > FACET_BUCKET_CHECK.max_depth {
        return Err(TOO_DEEP);
    }
    Ok((entries, size.nodes))
}

/// How deep a value nests (a scalar none, a collection one more than its
/// deepest item) and how many values it holds, itself included.
struct Size {
    depth: usize,
    nodes: usize,
}

fn size_of(value: &Value) -> Size {
    match value {
        Value::Seq(items) => within(items.iter()),
        Value::Map(entries) => within(entries.iter().map(|(_, item)| item)),
        _ => Size { depth: 0, nodes: 1 },
    }
}

/// The size of a collection holding `items`.
fn within<'a>(items: impl Iterator<Item = &'a Value>) -> Size {
    items.map(size_of).fold(Size { depth: 1, nodes: 1 }, |held, item| Size {
        depth: held.depth.max(item.depth.saturating_add(1)),
        nodes: held.nodes.saturating_add(item.nodes),
    })
}

fn answered(registry: &Registry, target: FacetTarget, bucket: &Map, library: &Map) -> Json {
    let kept = compose_library(registry, library).kept;
    let extra = [(AssetKind::Stencils, kept.as_slice())];
    match partition(registry, &extra, target, bucket) {
        Err(refused) => refusal(&refused),
        Ok(writes) => library_refusal(registry, &writes).unwrap_or_else(|| stored(writes)),
    }
}

fn stored(writes: Writes) -> Json {
    let sets = enumeration_order(Value::Map(writes.sets));
    let deletions = Value::Seq(writes.deletions.into_iter().map(Value::String).collect());
    json!(["ok", value_json(&sets), value_json(&deletions)])
}

/// The stencils of the library this bucket writes that the registry would drop.
///
/// The library is read as the server reads one: its stencils by name in code
/// unit order. The facet's own schema has already refused a name that is no
/// segment, so none is skipped unjudged.
fn library_refusal(registry: &Registry, writes: &Writes) -> Option<Json> {
    let (_, written) = writes.sets.iter().find(|(key, _)| key == STENCILS_KEY)?;
    let Value::Map(fields) = written else { return None };
    let (_, Value::Map(stencils)) = fields.iter().find(|(name, _)| name == "stencils")? else {
        return None;
    };
    let mut ordered = stencils.clone();
    ordered.sort_by(|(left, _), (right, _)| left.cmp(right));
    let dropped = compose_library(registry, &ordered).dropped;
    let names: Vec<Json> = dropped.iter().map(|(name, why)| stencil_json(name, why)).collect();
    (!names.is_empty()).then(|| json!(["refused", STENCILS_KEY, "library", names]))
}

fn stencil_json(name: &str, why: &StencilRefusal) -> Json {
    match why {
        StencilRefusal::Name => json!([name, "name"]),
        StencilRefusal::NoShape => json!([name, "no-shape"]),
        StencilRefusal::Shape(issues) => json!([name, "shape", issues_json(issues)]),
        StencilRefusal::Facet { key, why } => match why {
            PayloadRefusal::Unregistered => json!([name, "facet", key, "unregistered"]),
            PayloadRefusal::NotCurrent { current } => {
                json!([name, "facet", key, "not-current", current])
            }
            PayloadRefusal::Invalid(issues) => {
                json!([name, "facet", key, "invalid", issues_json(issues)])
            }
        },
    }
}

fn refusal(refused: &Refused) -> Json {
    let key = &refused.key;
    match &refused.why {
        Refusal::Target(targets) => {
            let held: Vec<&str> = targets.iter().map(|target| target.as_str()).collect();
            json!(["refused", key, "target", held])
        }
        Refusal::Write(WriteRefusal::MalformedKey) => json!(["refused", key, "malformed-key"]),
        Refusal::Write(WriteRefusal::NotCurrentVersion { current }) => {
            json!(["refused", key, "not-current", current])
        }
        Refusal::Write(WriteRefusal::Invalid(issues)) => {
            json!(["refused", key, "invalid", issues_json(issues)])
        }
        Refusal::Write(WriteRefusal::UnregisteredAsset { field, id, kind, registered }) => {
            json!(["refused", key, "unregistered-asset", field, id, kind.as_str(), registered])
        }
        Refusal::Unrecognized(stray) => {
            json!(["refused", key, "unrecognized-key", stray.path, stray.key])
        }
    }
}

fn issues_json(issues: &[Issue]) -> Json {
    Json::Array(issues.iter().map(issue_json).collect())
}

fn issue_json(issue: &Issue) -> Json {
    let path: Vec<Json> = issue
        .path
        .iter()
        .map(|step| match step {
            PathStep::Key(name) => json!(name),
            PathStep::Index(at) => json!(at),
        })
        .collect();
    json!([path, code(issue.code), detail(&issue.detail)])
}

/// What an issue carries beyond its path and code. A contract's own sentence
/// is not sent: the host words a refusal.
fn detail(detail: &Detail) -> Json {
    match detail {
        Detail::None | Detail::Message(_) => Json::Null,
        Detail::Keys(keys) => json!(["keys", keys]),
        Detail::Arms(arms) => {
            json!(["arms", arms.iter().map(|arm| issues_json(arm)).collect::<Vec<_>>()])
        }
        Detail::Key(inner) => json!(["key", issues_json(inner)]),
    }
}

fn code(code: Code) -> &'static str {
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
mod tests {
    use super::facet_bucket_check;
    use crate::input_caps::FACET_BUCKET_CHECK;
    use serde_json::{Value as Json, json};

    /// The items of an array answer from `from` to `to`, as a value that compares.
    fn part(whole: &Json, from: usize, to: usize) -> Json {
        let items = whole.as_array().map_or(&[][..], Vec::as_slice);
        Json::Array(items.iter().skip(from).take(to.saturating_sub(from)).cloned().collect())
    }

    fn answer(target: &str, bucket: &str, library: &str) -> Json {
        serde_json::from_str(&facet_bucket_check(target, bucket, library)).unwrap_or(Json::Null)
    }

    fn node(bucket: &str) -> Json {
        answer("node", bucket, r#"["m"]"#)
    }

    fn shape(kind: &str) -> String {
        format!(r#"["m","kind","{kind}"]"#)
    }

    /// A library of one stencil named `name` that carries no facet.
    fn library(name: &str) -> String {
        format!(r#"["m","{name}",["m","displayName","N"]]"#)
    }

    fn nested(levels: usize) -> String {
        format!("{}true{}", r#"["s","#.repeat(levels), "]".repeat(levels))
    }

    #[test]
    fn a_bucket_answers_its_parsed_sets_in_order_and_the_keys_it_deletes() {
        let bucket = format!(
            r#"["m","visual.shape/v0",{},"other.thing/v1",["s",["f","8000000000000000"],true,null],"visual.text/v0",null]"#,
            shape("cylinder")
        );
        assert_eq!(
            node(&bucket),
            json!([
                "ok",
                [
                    "m",
                    "visual.shape/v0",
                    shape_wire("cylinder"),
                    "other.thing/v1",
                    ["s", ["f", "8000000000000000"], true, null]
                ],
                ["s", "visual.text/v0"]
            ])
        );
        assert_eq!(node(r#"["m"]"#), json!(["ok", ["m"], ["s"]]));
    }

    fn shape_wire(kind: &str) -> Json {
        json!(["m", "kind", kind])
    }

    #[test]
    fn a_sets_keys_are_in_the_order_a_host_enumerates_them() {
        // The schema keeps nothing here, so what comes back is what an unregistered
        // facet sent, its integer-like keys first as a host object holds them.
        let sent = r#"["m","other.thing/v1",["m","b",true,"2",true,"1",true]]"#;
        let Json::Array(parts) = node(sent) else { return };
        let enumerated = parts.get(1).cloned().unwrap_or(Json::Null);
        assert_eq!(
            enumerated,
            json!(["m", "other.thing/v1", ["m", "1", true, "2", true, "b", true]])
        );
    }

    #[test]
    fn the_first_refused_key_answers_with_the_stage_and_what_it_says() {
        let canvas = answer(
            "canvas",
            &format!(r#"["m","visual.shape/v0",{}]"#, shape("cylinder")),
            r#"["m"]"#,
        );
        assert_eq!(canvas, json!(["refused", "visual.shape/v0", "target", ["node"]]));
        assert_eq!(node(r#"["m","nope",true]"#), json!(["refused", "nope", "malformed-key"]));
        assert_eq!(
            node(r#"["m","visual.shape/v3",["m"]]"#),
            json!(["refused", "visual.shape/v3", "not-current", "visual.shape/v0"])
        );
        let stripped = node(r#"["m","visual.shape/v0",["m","kind","cylinder","bogus",true]]"#);
        assert_eq!(
            stripped,
            json!(["refused", "visual.shape/v0", "unrecognized-key", [], "bogus"])
        );
        let invalid = node(&format!(r#"["m","visual.shape/v0",{}]"#, shape("blob")));
        assert_eq!(
            part(&invalid, 0, 3),
            json!([json!("refused"), json!("visual.shape/v0"), json!("invalid")])
        );
        assert_eq!(invalid[3][0][1], "invalid_value");
        assert_eq!(invalid[3][0][0], json!(["kind"]));
        // Earlier keys win, and a key before a refusal is not stored.
        let two = node(r#"["m","nope",true,"visual.shape/v3",["m"]]"#);
        assert_eq!(two, json!(["refused", "nope", "malformed-key"]));
    }

    #[test]
    fn a_stencil_a_write_names_must_be_registered_by_the_deployment_or_the_stored_library() {
        let stencil = r#"["m","visual.stencil/v0",["m","stencil","workspace.mine"]]"#;
        let refused = node(stencil);
        assert_eq!(refused[2], "unregistered-asset");
        assert_eq!(
            part(&refused, 3, 6),
            json!([json!("stencil"), json!("workspace.mine"), json!("stencils")])
        );
        let held = refused[6].as_array().map_or(0, Vec::len);
        assert!(held > 5, "the deployment's stencils are listed");
        assert_eq!(answer("node", stencil, &library("mine"))[0], "ok");
        // The kept stencils follow the registry's own, in the library's order.
        let other = answer("node", stencil, &library("other"));
        let listed = other[6].as_array().cloned().unwrap_or_default();
        assert_eq!(listed.len(), held + 1);
        assert_eq!(listed.last(), Some(&json!("workspace.other")));
        // A stored stencil the registry would drop registers nothing.
        let bad = r#"["m","mine",["m","displayName",""]]"#;
        assert_eq!(answer("node", stencil, bad)[2], "unregistered-asset");
        assert_eq!(answer("node", stencil, bad)[6].as_array().map(Vec::len), Some(held));
    }

    fn written_library(stencils: &str) -> Json {
        let bucket = format!(r#"["m","visual.stencils/v0",["m","stencils",{stencils}]]"#);
        answer("document", &bucket, r#"["m"]"#)
    }

    #[test]
    fn a_library_a_write_carries_is_refused_naming_each_stencil_the_registry_would_drop() {
        assert_eq!(written_library(&library("fine"))[0], "ok");
        let stencils = r#"["m",
          "zeta",["m","displayName","Z","facets",["m","visual.nothing/v0",["m"]]],
          "beta",["m","displayName","B","facets",["m","visual.shape/v1",["m"]]],
          "alpha",["m","displayName","A","facets",["m","visual.shape/v0",["m","kind","blob"]]],
          "kept",["m","displayName","K","facets",["m","visual.shape/v0",["m","kind","cylinder"]]]]"#;
        let refused = written_library(stencils);
        assert_eq!(
            part(&refused, 0, 3),
            json!([json!("refused"), json!("visual.stencils/v0"), json!("library")])
        );
        let dropped = refused[3].as_array().cloned().unwrap_or_default();
        let named: Vec<&Json> = dropped.iter().map(|entry| &entry[0]).collect();
        assert_eq!(named, ["alpha", "beta", "zeta"], "in name order, the kept one absent");
        assert_eq!(part(&dropped[0], 1, 3), json!([json!("facet"), json!("visual.shape/v0")]));
        assert_eq!(dropped[0][3], "invalid");
        assert_eq!(dropped[0][4][0][1], "invalid_value");
        assert_eq!(
            part(&dropped[1], 1, usize::MAX),
            json!([
                json!("facet"),
                json!("visual.shape/v1"),
                json!("not-current"),
                json!("visual.shape/v0")
            ])
        );
        assert_eq!(
            part(&dropped[2], 1, usize::MAX),
            json!([json!("facet"), json!("visual.nothing/v0"), json!("unregistered")])
        );
    }

    #[test]
    fn the_library_is_judged_after_every_key_has_passed_and_only_when_it_is_stored() {
        let bad = r#"["m","a",["m","displayName","A","facets",["m","visual.nothing/v0",["m"]]]]"#;
        let write = |tail: &str| {
            let head = format!(r#"["m","visual.stencils/v0",["m","stencils",{bad}]"#);
            answer("document", &format!("{head}{tail}]"), r#"["m"]"#)
        };
        // A later key refused at its own stage is answered first.
        let hold = write(r#","nope",true"#);
        assert_eq!(hold, json!(["refused", "nope", "malformed-key"]));
        assert_eq!(write("")[2], "library");
        let on_a_node = format!(r#"["m","visual.stencils/v0",["m","stencils",{bad}]]"#);
        assert_eq!(node(&on_a_node)[2], "target", "a library is a document's, not a node's");
        // A deleted library is judged by nothing.
        let deleted = answer("document", r#"["m","visual.stencils/v0",null]"#, r#"["m"]"#);
        assert_eq!(deleted, json!(["ok", ["m"], ["s", "visual.stencils/v0"]]));
        // A library written beside others is still found.
        let beside = format!(
            r#"["m","visual.tags/v0",["m","keys",["m"]],"visual.stencils/v0",["m","stencils",{bad}]]"#
        );
        assert_eq!(answer("document", &beside, r#"["m"]"#)[2], "library");
    }

    #[test]
    fn a_list_a_schema_refuses_names_each_place_and_each_arm() {
        let refused = node(r#"["m","visual.symbol/v0",["f","4008000000000000"]]"#);
        assert_eq!(refused[2], "invalid");
        assert_eq!(refused[3][0][1], "invalid_union");
        assert_eq!(refused[3][0][2][0], "arms");
        let lines = answer(
            "document",
            r#"["m","visual.tags/v0",["m","keys",["m","Bad Key",["m"]]]]"#,
            r#"["m"]"#,
        );
        assert_eq!(lines[2], "invalid");
        assert!(lines[3].to_string().contains("\"key\""), "{}", lines[3]);
    }

    #[test]
    fn a_call_the_core_does_not_answer_is_declined_with_the_code_and_class_of_its_input() {
        let wire = json!(["declined", "malformed", "wire"]);
        assert_eq!(answer("elsewhere", r#"["m"]"#, r#"["m"]"#), wire);
        for bucket in ["", "{", "[]", r#"["m","a"]"#, r#"["m","a",1,"a",2]"#, r#"{"a":1}"#, "[1]"] {
            assert_eq!(answer("node", bucket, r#"["m"]"#), wire, "{bucket}");
            assert_eq!(answer("node", r#"["m"]"#, bucket), wire, "{bucket}");
        }
        let deep = json!(["declined", "malformed", "too-deep"]);
        let within = format!(r#"["m","other.x/v0",{}]"#, nested(FACET_BUCKET_CHECK.max_depth - 1));
        assert_eq!(node(&within)[0], "ok", "the bucket and each level of its payload count");
        let over = format!(r#"["m","other.x/v0",{}]"#, nested(FACET_BUCKET_CHECK.max_depth));
        assert_eq!(node(&over), deep);
        assert_eq!(answer("node", r#"["m"]"#, &over), deep);
    }

    fn padded(bytes: usize) -> String {
        let frame = r#"["m","other.x/v0",""]"#.len();
        format!(r#"["m","other.x/v0","{}"]"#, "x".repeat(bytes - frame))
    }

    #[test]
    fn input_past_the_cap_is_declined_whichever_of_the_two_it_is_in() {
        let max = FACET_BUCKET_CHECK.max_bytes;
        let large = json!(["declined", "input-too-large", "too-large"]);
        let empty = r#"["m"]"#.len();
        assert_eq!(node(&padded(max - empty))[0], "ok", "exactly the cap is read");
        assert_eq!(node(&padded(max - empty + 1)), large);
        assert_eq!(answer("node", r#"["m"]"#, &padded(max - empty))[0], "ok");
        let library = padded(max - empty + 1);
        assert_eq!(answer("node", r#"["m"]"#, &library), large, "either may be the large one");
        assert_eq!(
            answer("node", &padded(max - 10), &padded(30)),
            large,
            "the two are counted together"
        );
    }

    #[test]
    fn input_holding_more_values_than_the_cap_is_declined_whichever_of_the_two_holds_them() {
        let max = FACET_BUCKET_CHECK.max_nodes.unwrap_or(0);
        let list = |items: usize| format!(r#"["s",{}]"#, vec!["true"; items].join(","));
        let many = json!(["declined", "input-too-large", "too-many"]);
        // The bucket's mapping, its payload and the library's mapping are three values and
        // each item one more.
        let bucket = |items: usize| format!(r#"["m","other.x/v0",{}]"#, list(items));
        assert_eq!(node(&bucket(max - 3))[0], "ok", "exactly the cap is read");
        assert_eq!(node(&bucket(max - 2)), many);
        let stored = |items: usize| format!(r#"["m","a",{}]"#, list(items));
        assert_eq!(answer("node", r#"["m"]"#, &stored(max - 3))[0], "ok");
        assert_eq!(answer("node", r#"["m"]"#, &stored(max - 2)), many);
        assert_eq!(answer("node", &bucket(max / 2), &stored(max / 2)), many, "counted together");
    }

    #[test]
    fn a_mapping_counts_for_depth_and_for_values_as_a_list_does() {
        let max = FACET_BUCKET_CHECK.max_depth;
        let maps =
            |levels: usize| format!("{}true{}", r#"["m","k","#.repeat(levels), "]".repeat(levels));
        let bucket = |levels: usize| format!(r#"["m","other.x/v0",{}]"#, maps(levels));
        assert_eq!(node(&bucket(max - 1))[0], "ok");
        assert_eq!(node(&bucket(max)), json!(["declined", "malformed", "too-deep"]));
        let nodes = FACET_BUCKET_CHECK.max_nodes.unwrap_or(0);
        let keyed = |items: usize| {
            let pairs: Vec<String> = (0..items).map(|at| format!(r#""k{at}",true"#)).collect();
            format!(r#"["m","other.x/v0",["m",{}]]"#, pairs.join(","))
        };
        assert_eq!(node(&keyed(nodes - 3))[0], "ok");
        assert_eq!(node(&keyed(nodes - 2)), json!(["declined", "input-too-large", "too-many"]));
    }
}
