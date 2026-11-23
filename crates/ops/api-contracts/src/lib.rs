//! The refusals every surface answers with (ADR-0054 decision 8): one code,
//! HTTP status and sentence each, generated from `contracts/api/refusals.json`
//! so the Rust operations refuse a request in the TypeScript's own words.
//!
//! The enum is generated; `refusal_text` holds the filters its templates name,
//! and `port_error` maps what a port answers to the refusal it travels as.

mod port_error;
mod refusal_text;
#[path = "generated/refusals.rs"]
mod refusals;

pub use refusals::{CODES, Refusal, SYNC_WRITE_CODES, VERSION_CODES, code};

#[cfg(test)]
mod contract_tests;
