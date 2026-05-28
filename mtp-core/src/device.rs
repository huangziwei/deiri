//! MTP device enumeration.
//!
//! Wraps `mtp_rs::MtpDevice::list_devices()` to expose a serializable
//! descriptor the frontend's sidebar can render directly. The `id` field is
//! USB serial when the device exposes one, falling back to a derived string
//! anchored on `location_id` (which changes if the user moves the cable to a
//! different port — acceptable; the alternative is opening a session to write
//! a marker, which we don't do at enumeration time).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DeviceDescriptor {
    /// Stable identifier preferred for sidebar identity. Survives reconnection.
    pub id: String,
    /// Human label: "Manufacturer Product" when available.
    pub label: String,
    pub vendor_id: u16,
    pub product_id: u16,
    /// Opaque token passed to `MtpFs::open`. Not stable across reboots.
    ///
    /// Serialized as a string because mtp-rs returns values above
    /// `Number.MAX_SAFE_INTEGER` (2^53) — JSON-number round-trip through JS
    /// corrupts the low bits and the device can't be opened. See
    /// `crate::serde_u64_str`.
    #[serde(with = "crate::serde_u64_str")]
    pub location_id: u64,
}

pub fn list_devices() -> anyhow::Result<Vec<DeviceDescriptor>> {
    let devices = mtp_rs::MtpDevice::list_devices()
        .map_err(|e| anyhow::anyhow!("MTP enumeration failed: {e}"))?;

    let descriptors: Vec<DeviceDescriptor> = devices
        .into_iter()
        .map(|d| {
            let label = match (&d.manufacturer, &d.product) {
                (Some(m), Some(p)) => format!("{m} {p}"),
                (None, Some(p)) => p.clone(),
                (Some(m), None) => m.clone(),
                (None, None) => format!("MTP device {:04x}:{:04x}", d.vendor_id, d.product_id),
            };
            let id = d
                .serial_number
                .clone()
                .unwrap_or_else(|| format!("anon-{:x}", d.location_id));
            DeviceDescriptor {
                id,
                label,
                vendor_id: d.vendor_id,
                product_id: d.product_id,
                location_id: d.location_id,
            }
        })
        .collect();

    tracing::info!(
        count = descriptors.len(),
        devices = ?descriptors
            .iter()
            .map(|d| format!(
                "{:04x}:{:04x} loc={:x} id={} label={:?}",
                d.vendor_id, d.product_id, d.location_id, d.id, d.label
            ))
            .collect::<Vec<_>>(),
        "list_devices",
    );

    Ok(descriptors)
}
