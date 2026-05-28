//! Serialize `u64` as a JSON string.
//!
//! Tauri's IPC layer serializes Rust values to JSON for the WebView. JSON
//! numbers are IEEE-754 doubles in JavaScript, which can represent integers
//! exactly only up to 2^53 (`Number.MAX_SAFE_INTEGER`). mtp-rs hands us
//! `location_id` values well above that range (observed: 8.1e18), so a
//! round-trip through `Number` corrupts the low bits and `open_by_location`
//! looks for a device that doesn't exist.
//!
//! Wrap `location_id` (and any other big-u64 field that crosses IPC) with
//! `#[serde(with = "mtp_core::serde_u64_str")]`. JS sees a string;
//! Rust still sees a `u64`.

use serde::{Deserialize, Deserializer, Serializer};

pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&v.to_string())
}

pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let s = String::deserialize(d)?;
    s.parse().map_err(serde::de::Error::custom)
}
