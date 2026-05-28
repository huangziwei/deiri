#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/app/src-tauri"
cargo tauri build --bundles app "$@"

rm -rf /Applications/Deiri.app
cp -R ../../target/release/bundle/macos/Deiri.app /Applications/
echo "Installed to /Applications/Deiri.app"