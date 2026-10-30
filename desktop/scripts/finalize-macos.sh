#!/bin/bash
# Tauri may finish notarization without attaching a ticket after a CloudKit outage.
# Finalize each installer from a ticketed app, then re-sign its updater archive.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
source "$root/desktop/scripts/apple-retry.sh"
arch=${1:?expected aarch64 or x64}
[[ "$arch" == aarch64 || "$arch" == x64 ]] || exit 64
product=$(node -p "require('./desktop/src-tauri/tauri.conf.json').productName")
version=$(node -p "require('./desktop/src-tauri/tauri.conf.json').version")
[[ "$product" == Satuwork || "$product" == Satuwork-CN || "$product" == Satuwork-CN-Beta ]] || exit 64
for name in SATUWORK_CODESIGN_IDENTITY SATUWORK_CODESIGN_KEYCHAIN APPLE_API_KEY_PATH APPLE_API_KEY APPLE_API_ISSUER TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  [ -n "${!name:-}" ] || { echo "Missing protected signing setting: $name" >&2; exit 1; }
done
retry() {
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then return 0; fi
    [ "$attempt" -eq 3 ] || sleep 15
  done
  return 1
}
b="$root/desktop/src-tauri/target/release/bundle"
app="$b/macos/$product.app"
codesign --verify --deep --strict "$app"
if ! xcrun stapler validate "$app"; then
  retry_apple xcrun stapler staple "$app"
  retry_apple xcrun stapler validate "$app"
fi
stage=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/satuwork-dmg.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/disk"
ditto "$app" "$stage/disk/$product.app"
ln -s /Applications "$stage/disk/Applications"
mkdir -p "$b/dmg"
dmg="$b/dmg/${product}_${version}_${arch}.dmg"
hdiutil create -volname "$product" -srcfolder "$stage/disk" -ov -format UDZO "$dmg"
codesign --force --sign "$SATUWORK_CODESIGN_IDENTITY" --keychain "$SATUWORK_CODESIGN_KEYCHAIN" --timestamp "$dmg"
echo 'Submitting the signed installer for Apple notarization'
notarize() {
  xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait --timeout 30m --output-format json > "$stage/notary.json"
}
retry notarize
node -e 'const r=require(process.argv[1]); if(r.status!=="Accepted") throw Error("Apple notarization status: "+r.status); console.log("Apple notarization: Accepted")' "$stage/notary.json"
retry_apple xcrun stapler staple "$dmg"
retry_apple xcrun stapler validate "$dmg"
# The archive must contain the app with its ticket. Replacing its bytes also requires a new signature.
tar -czf "$b/macos/$product.app.tar.gz" -C "$b/macos" "$product.app"
pnpm --filter satuwork-desktop exec tauri signer sign "$b/macos/$product.app.tar.gz"
echo "Finalized $product $version ($arch)"
