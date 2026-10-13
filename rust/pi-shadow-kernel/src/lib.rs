//! pi-shadow-kernel: the pure computational kernel of pi-shadow-mind.
//!
//! Built as an `rlib` for host-side unit tests and as a `cdylib` for
//! `wasm32-unknown-unknown`; the JS boundary lives in `exports.rs` and is only
//! compiled for the wasm target, so `cargo test` on the host never touches
//! wasm-bindgen.

pub mod config;
pub mod gatekeeper;
pub mod protocol;
pub mod registry;
pub mod scheduler;
pub mod summaries;
pub mod trajectory;
pub mod types;
pub mod usage;
pub mod util;
pub mod validation;

// wasm32-unknown-unknown has no default allocator; wee_alloc provides a tiny one.
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

#[cfg(target_arch = "wasm32")]
mod exports;
