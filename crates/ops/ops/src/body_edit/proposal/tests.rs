//! Which proposal a call continues, the id and the stamps it takes, and the
//! ceiling on open changes, over proposals built to the figure.

use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::Map;

fn change(id: &str, status: &str) -> Value {
    Value::Map(vec![
        ("id".to_owned(), Value::String(id.to_owned())),
        ("status".to_owned(), Value::String(status.to_owned())),
    ])
}

/// A stored proposal of `id` holding `changes`, opened by `author` at `at`.
fn proposal(id: &str, changes: Vec<Value>, stamps: Option<(&str, &str)>) -> Value {
    let mut entries: Map = vec![("id".to_owned(), Value::String(id.to_owned()))];
    if let Some((author, at)) = stamps {
        entries.push(("author".to_owned(), Value::String(author.to_owned())));
        entries.push(("createdAt".to_owned(), Value::String(at.to_owned())));
    }
    entries.push(("changes".to_owned(), Value::Seq(changes)));
    Value::Map(entries)
}

fn open(count: usize, prefix: &str) -> Vec<Value> {
    (0..count).map(|at| change(&format!("{prefix}{at}"), "open")).collect()
}

fn input(proposal_id: Option<&str>, author: Option<&str>) -> BodyEditInput {
    BodyEditInput {
        workspace_id: "w".to_owned(),
        document_id: "d".to_owned(),
        mode: None,
        proposal_id: proposal_id.map(str::to_owned),
        author: author.map(str::to_owned),
        ops: Vec::new(),
    }
}

#[test]
fn a_proposal_is_found_by_its_id_and_lists_its_changes() {
    let held = [proposal("a", open(2, "x"), None), proposal("b", open(1, "y"), None)];
    assert_eq!(find(&held, "b").map(change_ids), Some(vec!["y0".to_owned()]));
    assert_eq!(find(&held, "a").map(change_ids), Some(vec!["x0".to_owned(), "x1".to_owned()]));
    assert!(find(&held, "c").is_none());
    assert_eq!(change_ids(&Value::Null), Vec::<String>::new());
    assert_eq!(change_ids(&change("n", "open")), Vec::<String>::new());
}

#[test]
fn the_first_free_id_is_minted() {
    let ids = |names: &[&str]| -> Vec<Value> {
        names.iter().map(|id| proposal(id, Vec::new(), None)).collect()
    };
    assert_eq!(mint(&[]), "p1");
    assert_eq!(mint(&ids(&["p1"])), "p2");
    assert_eq!(mint(&ids(&["p1", "p3"])), "p2", "a gap is filled");
    assert_eq!(mint(&ids(&["p2", "x"])), "p1");
    assert_eq!(mint(&ids(&["p1", "p2", "p3"])), "p4");
}

#[test]
fn a_new_proposal_takes_the_author_and_the_time_of_this_call() {
    let held = [proposal("p1", open(1, "x"), Some(("old", "then")))];
    let fresh = Stored::of(&input(None, Some("me")), None, &held, "now");
    assert_eq!(
        (fresh.id.as_str(), fresh.author.as_deref(), fresh.created_at.as_str()),
        ("p2", Some("me"), "now")
    );
    let named = Stored::of(&input(Some("z"), None), None, &held, "now");
    assert_eq!((named.id.as_str(), named.author), ("z", None));
}

#[test]
fn a_continuation_keeps_who_opened_it_and_when() {
    let held = [proposal("p1", open(1, "x"), Some(("old", "then")))];
    let kept = Stored::of(&input(Some("p1"), Some("me")), held.first(), &held, "now");
    assert_eq!(
        (kept.id.as_str(), kept.author.as_deref(), kept.created_at.as_str()),
        ("p1", Some("old"), "then")
    );
}

#[test]
fn a_continuation_of_a_proposal_that_named_nobody_takes_the_author_of_this_call() {
    let held = [proposal("p1", open(1, "x"), None)];
    let kept = Stored::of(&input(Some("p1"), Some("me")), held.first(), &held, "now");
    assert_eq!((kept.author.as_deref(), kept.created_at.as_str()), (Some("me"), "now"));
}

fn stored(id: &str) -> Stored {
    Stored { id: id.to_owned(), author: None, created_at: "now".to_owned() }
}

fn ceiling(open: u64) -> Refusal {
    Refusal::OpenChangesCeiling {
        open,
        limit:
            "the limit of 1000 open proposed changes for one document; adopt or dismiss some first"
                .to_owned(),
    }
}

#[test]
fn the_thousandth_open_change_is_kept_and_the_next_is_refused() {
    let held = [proposal("p1", open(999, "x"), None)];
    assert_eq!(stored("p2").refuse_growth(&held, &open(1, "n")), Ok(()));
    assert_eq!(stored("p2").refuse_growth(&held, &open(2, "n")), Err(ceiling(1001)));
}

#[test]
fn open_changes_are_counted_across_every_proposal() {
    let held = [proposal("p1", open(600, "a"), None), proposal("p2", open(400, "b"), None)];
    assert_eq!(stored("p3").refuse_growth(&held, &open(1, "n")), Err(ceiling(1001)));
    assert_eq!(stored("p1").refuse_growth(&held, &open(1, "n")), Err(ceiling(1001)));
}

#[test]
fn a_decided_change_is_not_open() {
    let mut changes = open(998, "a");
    changes.extend([change("d1", "adopted"), change("d2", "dismissed")]);
    let held = [proposal("p1", changes, None)];
    assert_eq!(stored("p2").refuse_growth(&held, &open(2, "n")), Ok(()));
    assert_eq!(stored("p2").refuse_growth(&held, &open(3, "n")), Err(ceiling(1001)));
}

#[test]
fn a_change_written_under_a_held_id_replaces_it_rather_than_adding_one() {
    let held = [proposal("p1", open(1000, "a"), None)];
    let again = vec![change("a0", "open"), change("a1", "open")];
    assert_eq!(stored("p1").refuse_growth(&held, &again), Ok(()), "two replaced, none added");
    let more = vec![change("a0", "open"), change("new", "open")];
    assert_eq!(stored("p1").refuse_growth(&held, &more), Err(ceiling(1001)));
}

#[test]
fn a_document_already_past_the_ceiling_takes_a_write_that_does_not_grow_it() {
    let held = [proposal("p1", open(1005, "a"), None)];
    assert_eq!(stored("p1").refuse_growth(&held, &[change("a0", "open")]), Ok(()));
    assert_eq!(stored("p1").refuse_growth(&held, &[change("n", "open")]), Err(ceiling(1006)));
}

#[test]
fn the_proposal_is_written_with_only_the_fields_it_has_and_the_changes_of_the_call() {
    let named =
        Stored { id: "p1".to_owned(), author: Some("me".to_owned()), created_at: "now".to_owned() };
    let write = named.write(vec![change("c", "open")]);
    assert_eq!(write.op, WriterName::WriteProposal);
    let Value::Map(args) = write.args else { panic!("a map") };
    let Some((key, Value::Map(fields))) = args.first() else { panic!("a proposal") };
    assert_eq!(key, "proposal");
    let keys: Vec<&str> = fields.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["id", "author", "createdAt", "changes"]);
    let anonymous = stored("p2").write(Vec::new());
    let Value::Map(args) = anonymous.args else { panic!("a map") };
    let Some((_, Value::Map(fields))) = args.first() else { panic!("a proposal") };
    let keys: Vec<&str> = fields.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["id", "createdAt", "changes"]);
}
