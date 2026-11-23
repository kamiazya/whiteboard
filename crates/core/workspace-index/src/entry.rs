//! The entry a port answers for a found document.

/// What a tree-backed index found about one document.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub document_id: String,
    pub path: String,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub shadowed: Option<bool>,
    pub created_at: Option<f64>,
    pub updated_at: Option<f64>,
    pub content_digest: String,
}

/// The entry a port answers; absent fields stay absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentEntry {
    pub document_id: String,
    pub path: String,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub shadowed: Option<bool>,
    pub updated_at: Option<String>,
    pub content_digest: String,
}

/// A timestamp no JavaScript `Date` holds, which `toISOString` refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryError {
    InvalidTime,
}

/// `entryOf`. A create and a content write stamp `updatedAt`; a rename or a
/// move does not, so the stamp falls back to `createdAt` for a record written
/// before timestamps landed, and is absent for one that predates both.
pub fn entry_of(found: &Found) -> Result<DocumentEntry, EntryError> {
    let updated_at = match found.updated_at.or(found.created_at) {
        Some(stamp) => Some(iso_string(stamp)?),
        None => None,
    };
    Ok(DocumentEntry {
        document_id: found.document_id.clone(),
        path: found.path.clone(),
        kind: found.kind.clone(),
        name: found.name.clone(),
        shadowed: found.shadowed,
        updated_at,
        content_digest: found.content_digest.clone(),
    })
}

/// Whether a JavaScript `Date` holds `ms`, which a write checks of the clock it
/// stamps with before it writes, since the entry it answers is read back through
/// `toISOString`.
pub fn require_time(ms: f64) -> Result<(), EntryError> {
    iso_string(ms).map(|_| ())
}

/// `new Date(ms).toISOString()`, with the refusal this index names.
fn iso_string(ms: f64) -> Result<String, EntryError> {
    whiteboard_det::date::iso_string(ms).map_err(|_| EntryError::InvalidTime)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_time_the_date_object_refuses_is_refused_and_one_it_holds_is_not() {
        assert_eq!(iso_string(0.0).as_deref(), Ok("1970-01-01T00:00:00.000Z"));
        assert_eq!(require_time(8.64e15), Ok(()));
        assert_eq!(iso_string(8.64e15 + 1.0), Err(EntryError::InvalidTime));
        assert_eq!(require_time(f64::NAN), Err(EntryError::InvalidTime));
    }

    #[test]
    fn the_stamp_falls_back_to_created_at_and_may_be_absent() {
        let mut found = Found {
            document_id: "d".to_owned(),
            path: "a".to_owned(),
            kind: None,
            name: None,
            shadowed: None,
            created_at: Some(0.0),
            updated_at: None,
            content_digest: "x".to_owned(),
        };
        assert_eq!(
            entry_of(&found).map(|entry| entry.updated_at),
            Ok(Some("1970-01-01T00:00:00.000Z".to_owned()))
        );
        found.created_at = None;
        assert_eq!(entry_of(&found).map(|entry| entry.updated_at), Ok(None));
    }
}
