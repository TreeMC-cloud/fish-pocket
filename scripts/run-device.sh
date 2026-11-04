#!/usr/bin/env bash
# Build the engine tree and the app for a connected iPhone, install, launch, and
# stream the app's console: DEVELOPMENT_TEAM=<team> run-device.sh [device-id]
# The device defaults to the first paired, available iPhone.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
: "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM to your signing team id}"
device="${1:-$(xcrun devicectl list devices 2>/dev/null | awk '/available \(paired\)/ && /iPhone/ {for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F-]{36}$/) {print $i; exit}}')}"
[ -n "$device" ] || { echo "no paired iPhone found" >&2; exit 1; }
# xcodebuild addresses devices by hardware UDID, devicectl by its own identifier.
info="$(mktemp)"
xcrun devicectl device info details --device "$device" --json-output "$info" >/dev/null
udid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["hardwareProperties"]["udid"])' "$info")"
rm -f "$info"
[ -d "$root/vendor/nodejs-mobile/rooted" ] || "$root/scripts/fetch-nodejs-mobile.sh"
[ -d "$root/vendor/libgit2/Libgit2.xcframework" ] || "$root/scripts/build-libgit2.sh"
"$root/scripts/build-engine.sh"
cd "$root/app"
xcodegen generate --quiet
xcodebuild -project DshIOS.xcodeproj -scheme DshIOS -configuration Debug -destination "id=$udid" \
  -derivedDataPath build/DerivedData -skipPackagePluginValidation -allowProvisioningUpdates DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" build -quiet
app="build/DerivedData/Build/Products/Debug-iphoneos/DshIOS.app"
xcrun devicectl device install app --device "$device" "$app"
xcrun devicectl device process launch --device "$device" --terminate-existing --console com.wsw.dsh-ios
