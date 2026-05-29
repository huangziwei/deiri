# Deiri 出入り

<p align="center"><img src="./.github/assets/icon.png" width="128" height="128"/></p>

A macOS app for getting files in and out of MTP devices (newer Kindles, Android phones, cameras, etc.).

Built with [Tauri](https://tauri.app/) on top of [`mtp-rs`](https://crates.io/crates/mtp-rs).

## Screenshots

<p align="center">
  <img src=".github/assets/view-list.png" alt="List view" width="400" />
  <img src=".github/assets/view-grid.png" alt="Grid view" width="400" />
</p>

## Build

```sh
git clone https://github.com/huangziwei/deiri && cd deiri
./build.sh
```

Builds `Deiri.app` and installs it to `/Applications/`.

Tested on macOS 26.4 with Rust 1.95.
