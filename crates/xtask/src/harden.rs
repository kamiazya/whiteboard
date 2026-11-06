//! `cargo xtask harden-check <binary>...`: a release binary carries the
//! platform's exploit mitigations (QR-28d) before it is published.
//!
//! For a 64-bit ELF every one of these must hold, or the check fails:
//!
//! - **PIE**: `ET_DYN` with a `PT_INTERP` (a shared library has none), so
//!   ASLR can move the executable itself.
//! - **Full RELRO**: a `PT_GNU_RELRO` segment AND immediate binding
//!   (`DT_BIND_NOW`, `DF_BIND_NOW` or `DF_1_NOW`); without immediate binding
//!   the GOT stays writable, which is only partial RELRO.
//! - **NX**: a `PT_GNU_STACK` without the execute flag. No such header means
//!   an executable stack on most loaders, so absence fails.
//! - **No RPATH/RUNPATH**: a baked-in library search path is a library
//!   planting vector for a binary run from a user-writable location.
//! - **Stripped**: no `.symtab` and no `.debug_*` section.
//! - **Dependency list embedded**: cargo-auditable's `.dep-v0` section, so a
//!   shipped binary can be audited against the `RustSec` database without its lockfile.
//!
//! The stack protector is REPORTED, not required. rustc's
//! `-Z stack-protector` is nightly-only, so a stable release build has none;
//! what stands in for it is that safe Rust bounds-checks every slice access,
//! and `unsafe` is forbidden outside bindings (QR-28g). C code linked in by a
//! dependency would be the place it matters: `--require-stack-protector`
//! makes its absence a failure once a release build can supply one.
//!
//! Mach-O and PE fail CLOSED: no binary of either format is built by this
//! workspace yet, and a check that has never run against a real binary of
//! its format would be a guess about that format's flags.

use object::elf;
use object::read::elf::{Dyn, ElfFile64, FileHeader, ProgramHeader};
use object::{Endianness, Object, ObjectSection};

/// What was found in one binary.
#[derive(Debug, Default, PartialEq, Eq)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "one flag per independent mitigation, read and reported one by one"
)]
pub(crate) struct Findings {
    pub(crate) pie: bool,
    pub(crate) relro_segment: bool,
    pub(crate) bind_now: bool,
    pub(crate) nx_stack: bool,
    pub(crate) rpath: bool,
    pub(crate) symtab: bool,
    pub(crate) debug_sections: usize,
    pub(crate) audit_data: bool,
    pub(crate) stack_protector: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Policy {
    pub(crate) require_stack_protector: bool,
}

pub(crate) fn inspect(data: &[u8]) -> Result<Findings, String> {
    // Told apart by magic rather than through object's format features, so
    // the reader keeps only the ELF half it actually uses.
    match data {
        [0x7f, b'E', b'L', b'F', 2, ..] => inspect_elf64(data),
        [0x7f, b'E', b'L', b'F', ..] => Err("not yet: 32-bit ELF; no release target builds one".to_owned()),
        [0xfe, 0xed, 0xfa, 0xce | 0xcf, ..] | [0xce | 0xcf, 0xfa, 0xed, 0xfe, ..] | [0xca, 0xfe, 0xba, 0xbe, ..] => Err(
            "not yet: Mach-O (PIE, no executable stack/heap, stripped, hardened runtime) is checked once the darwin release job builds a binary to prove it on".to_owned(),
        ),
        [b'M', b'Z', ..] => Err(
            "not yet: PE (DYNAMIC_BASE, HIGH_ENTROPY_VA, NX_COMPAT, CET/CFG, no debug directory) is checked once the windows release job builds a binary to prove it on".to_owned(),
        ),
        _ => Err("not a release binary format this check reads (ELF, Mach-O, PE)".to_owned()),
    }
}

fn inspect_elf64(data: &[u8]) -> Result<Findings, String> {
    let file =
        ElfFile64::<Endianness>::parse(data).map_err(|e| format!("ELF does not parse: {e}"))?;
    let endian = file.endian();
    let header = file.elf_header();
    let mut f = Findings::default();
    let mut interp = false;
    for ph in file.elf_program_headers() {
        match ph.p_type(endian) {
            elf::PT_INTERP => interp = true,
            elf::PT_GNU_RELRO => f.relro_segment = true,
            elf::PT_GNU_STACK => f.nx_stack = ph.p_flags(endian) & elf::PF_X == 0,
            elf::PT_DYNAMIC => {
                let entries = ph
                    .dynamic(endian, data)
                    .map_err(|e| format!("dynamic segment does not parse: {e}"))?
                    .unwrap_or_default();
                for d in entries {
                    let tag = d.d_tag(endian);
                    let val = d.d_val(endian);
                    let now = match tag {
                        elf::DT_BIND_NOW => true,
                        elf::DT_FLAGS => val & u64::from(elf::DF_BIND_NOW) != 0,
                        elf::DT_FLAGS_1 => val & u64::from(elf::DF_1_NOW) != 0,
                        _ => false,
                    };
                    f.bind_now |= now;
                    f.rpath |= matches!(tag, elf::DT_RPATH | elf::DT_RUNPATH);
                }
            }
            _ => {}
        }
    }
    f.pie = header.e_type(endian) == elf::ET_DYN && interp;
    for section in file.sections() {
        let name = section.name().unwrap_or_default();
        if name == ".symtab" {
            f.symtab = true;
        } else if name.starts_with(".debug") || name.starts_with(".zdebug") {
            f.debug_sections += 1;
        } else if name == ".dep-v0" {
            f.audit_data = true;
        }
    }
    // The dynamic symbol table survives stripping, so an import of the
    // canary-failure handler is visible either way.
    f.stack_protector = file
        .dynamic_symbols()
        .any(|s| object::ObjectSymbol::name(&s).is_ok_and(|n| n == "__stack_chk_fail"));
    Ok(f)
}

/// The failures, each naming the mitigation and how this workspace gets it.
pub(crate) fn verdict(f: &Findings, policy: Policy) -> Vec<String> {
    let mut v = Vec::new();
    if !f.pie {
        v.push(
            "not a position-independent executable (link with -C relocation-model=pie)".to_owned(),
        );
    }
    if !f.relro_segment {
        v.push("no PT_GNU_RELRO segment (-C relro-level=full)".to_owned());
    } else if !f.bind_now {
        v.push(
            "partial RELRO only: no BIND_NOW, so the GOT stays writable (-C relro-level=full)"
                .to_owned(),
        );
    }
    if !f.nx_stack {
        v.push("the stack is executable, or PT_GNU_STACK is missing".to_owned());
    }
    if f.rpath {
        v.push("carries an RPATH/RUNPATH".to_owned());
    }
    if f.symtab {
        v.push("not stripped: .symtab present (profile strip = \"symbols\")".to_owned());
    }
    if f.debug_sections > 0 {
        v.push(format!(
            "{} .debug sections present (profile strip = \"symbols\")",
            f.debug_sections
        ));
    }
    if !f.audit_data {
        v.push(
            "no .dep-v0 section: build it with `cargo auditable build` (`cargo xtask dist native`)"
                .to_owned(),
        );
    }
    if policy.require_stack_protector && !f.stack_protector {
        v.push("no stack protector (__stack_chk_fail is not imported)".to_owned());
    }
    v
}

const USAGE: &str = "usage: cargo xtask harden-check [--require-stack-protector] <binary>...";
const REQUIRE_STACK_PROTECTOR: &str = "--require-stack-protector";

/// The policy the flags ask for and the binaries to inspect. A flag the task
/// does not know is an error, never a dropped word: a misspelled
/// `--require-stack-protector` would otherwise relax the gate silently.
fn parse_args<'a>(args: &[&'a str]) -> Result<(Policy, Vec<&'a str>), Vec<String>> {
    let mut policy = Policy { require_stack_protector: false };
    let mut binaries = Vec::new();
    for arg in args {
        if *arg == REQUIRE_STACK_PROTECTOR {
            policy.require_stack_protector = true;
        } else if arg.starts_with("--") {
            return Err(vec![format!("harden-check: unknown flag {arg}; {USAGE}")]);
        } else {
            binaries.push(*arg);
        }
    }
    if binaries.is_empty() {
        return Err(vec![USAGE.to_owned()]);
    }
    Ok((policy, binaries))
}

pub(crate) fn run(args: &[&str]) -> Result<Vec<String>, Vec<String>> {
    let (policy, binaries) = parse_args(args)?;
    let mut ok = Vec::new();
    let mut failed = Vec::new();
    for path in binaries {
        let data = std::fs::read(path).map_err(|e| vec![format!("cannot read {path}: {e}")])?;
        match inspect(&data) {
            Err(e) => failed.push(format!("{path}: {e}")),
            Ok(f) => {
                let v = verdict(&f, policy);
                if v.is_empty() {
                    let sp = if f.stack_protector {
                        "stack protector present"
                    } else {
                        "no stack protector (not available on stable rustc; reported, not required)"
                    };
                    ok.push(format!(
                        "harden-check: {path}: PIE, full RELRO, NX, no RPATH, stripped, dependency list embedded; {sp}"
                    ));
                } else {
                    failed.extend(v.into_iter().map(|l| format!("{path}: {l}")));
                }
            }
        }
    }
    if failed.is_empty() {
        Ok(ok)
    } else {
        failed.insert(0, "harden-check: a release binary lacks a required mitigation:".to_owned());
        Err(failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hardened() -> Findings {
        Findings {
            pie: true,
            relro_segment: true,
            bind_now: true,
            nx_stack: true,
            rpath: false,
            symtab: false,
            debug_sections: 0,
            audit_data: true,
            stack_protector: false,
        }
    }

    const STABLE: Policy = Policy { require_stack_protector: false };

    #[test]
    fn an_unknown_flag_is_refused_rather_than_dropped() {
        let err = parse_args(&["--require-stack-protecter", "a.out"]).unwrap_err();
        assert!(err[0].contains("unknown flag --require-stack-protecter"), "{err:?}");
        let (policy, binaries) = parse_args(&["--require-stack-protector", "a.out"]).unwrap();
        assert!(policy.require_stack_protector);
        assert_eq!(binaries, vec!["a.out"]);
        assert_eq!(parse_args(&["--require-stack-protector"]).unwrap_err(), vec![USAGE.to_owned()]);
    }

    #[test]
    fn a_hardened_binary_passes_without_a_stack_protector_unless_required() {
        assert_eq!(verdict(&hardened(), STABLE), Vec::<String>::new());
        let strict = Policy { require_stack_protector: true };
        assert_eq!(verdict(&hardened(), strict).len(), 1);
    }

    #[test]
    fn each_missing_mitigation_fails_by_name() {
        for (f, needle) in [
            (Findings { pie: false, ..hardened() }, "position-independent"),
            (Findings { relro_segment: false, ..hardened() }, "PT_GNU_RELRO"),
            (Findings { bind_now: false, ..hardened() }, "partial RELRO"),
            (Findings { nx_stack: false, ..hardened() }, "executable"),
            (Findings { rpath: true, ..hardened() }, "RPATH"),
            (Findings { symtab: true, ..hardened() }, ".symtab"),
            (Findings { debug_sections: 3, ..hardened() }, ".debug"),
            (Findings { audit_data: false, ..hardened() }, ".dep-v0"),
        ] {
            let v = verdict(&f, STABLE);
            assert!(v.len() == 1 && v[0].contains(needle), "{needle}: {v:?}");
        }
    }

    #[test]
    fn this_test_binary_is_read_as_an_unstripped_pie_without_audit_data() {
        // A real ELF, built by cargo for the test run: PIE and RELRO by
        // rustc's defaults, but never stripped or audited. The parse reaches
        // every field rather than defaulting them.
        let data = std::fs::read(std::env::current_exe().unwrap()).unwrap();
        let f = inspect(&data).unwrap();
        assert!(f.pie && f.relro_segment && f.bind_now && f.nx_stack, "{f:?}");
        assert!(f.symtab && !f.audit_data, "{f:?}");
    }

    #[test]
    fn other_formats_fail_closed() {
        let mut macho = vec![0u8; 64];
        macho[..4].copy_from_slice(&0xfeed_facf_u32.to_le_bytes());
        assert!(inspect(&macho).unwrap_err().starts_with("not yet: Mach-O"));
        assert!(inspect(b"MZ\x90\0").unwrap_err().starts_with("not yet: PE"));
        assert!(inspect(b"\0asm\x01\0\0\0").is_err());
        assert!(inspect(b"plain text").is_err());
    }
}
