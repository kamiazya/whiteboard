//! The contract's own keywords: where its outputs and check modules may live.

use super::{Contract, DIALECT, prose};

/// The contract's own keywords: dialect, prose, output targets and check modules.
pub(super) fn check_header(contract: &Contract, v: &mut Vec<String>) {
    if contract.schema != DIALECT {
        v.push(format!("$schema: {} is not {DIALECT}", contract.schema));
    }
    for (what, text) in [("title", &contract.title), ("description", &contract.description)] {
        if let Err(e) = prose(text) {
            v.push(format!("{what}: {e}"));
        }
    }
    if let Err(e) = target(&contract.emit.zod, TargetKind::Zod) {
        v.push(format!("x-wb-emit.zod: {e}"));
    }
    if let Err(e) = target(&contract.emit.rust, TargetKind::Rust) {
        v.push(format!("x-wb-emit.rust: {e}"));
    }
    if let Some(modules) = &contract.checks {
        if let Some(zod) = &modules.zod
            && let Err(e) = sibling(zod, &contract.emit.zod, TargetKind::Zod)
        {
            v.push(format!("x-wb-checks.zod: {e}"));
        }
        if let Err(e) = sibling(&modules.rust, &contract.emit.rust, TargetKind::Rust) {
            v.push(format!("x-wb-checks.rust: {e}"));
        }
    }
}

#[derive(Clone, Copy)]
enum TargetKind {
    Zod,
    Rust,
}

/// A target lands only where the stray-file scan looks and the Rust job's
/// path scope reaches: `packages/<pkg>/src/generated/<stem>.zod.ts` and
/// `crates/<layer>/<crate>/src/generated/<stem>.rs`.
fn target(path: &str, kind: TargetKind) -> Result<(), String> {
    let parts: Vec<&str> = path.split('/').collect();
    let (root, dirs, suffix) = match kind {
        TargetKind::Zod => ("packages", 1, ".zod.ts"),
        TargetKind::Rust => ("crates", 2, ".rs"),
    };
    let shape_ok = parts.len() == dirs + 4
        && parts.first() == Some(&root)
        && parts.get(1..=dirs).is_some_and(|segs| segs.iter().all(|s| is_segment(s)))
        && parts.get(dirs + 1) == Some(&"src")
        && parts.get(dirs + 2) == Some(&"generated")
        && parts.last().and_then(|f| f.strip_suffix(suffix)).is_some_and(is_segment);
    if shape_ok {
        Ok(())
    } else {
        Err(format!("{path} is not {root}/{}src/generated/<name>{suffix}", "<dir>/".repeat(dirs)))
    }
}

fn is_segment(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// A hand-written module beside a generated output: the same package or
/// crate, directly under its `src`.
fn sibling(path: &str, output: &str, kind: TargetKind) -> Result<(), String> {
    let (root, dirs, suffix) = match kind {
        TargetKind::Zod => ("packages", 1, ".ts"),
        TargetKind::Rust => ("crates", 2, ".rs"),
    };
    let parts: Vec<&str> = path.split('/').collect();
    let home: Vec<&str> = output.split('/').take(dirs + 1).collect();
    let shape_ok = parts.len() == dirs + 3
        && parts.get(..=dirs) == Some(home.as_slice())
        && parts.get(dirs + 1) == Some(&"src")
        && parts.last().and_then(|f| f.strip_suffix(suffix)).is_some_and(is_segment);
    if shape_ok {
        Ok(())
    } else {
        Err(format!(
            "{path} is not {}src/<name>{suffix} in the output's own {root} directory",
            home.join("/") + "/"
        ))
    }
}
