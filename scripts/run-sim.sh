#!/usr/bin/env bash
# Build the engine tree and the app, install on the booted simulator, and
# stream the engine's console for a while (default 90 s): run-sim.sh [seconds]
# SIM_DEVICE picks the simulator (default "iPhone 17 Pro"); it is booted if needed.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
device="${SIM_DEVICE:-iPhone 17 Pro}"
xcrun simctl boot "$device" 2>/dev/null || true
[ -d "$root/vendor/nodejs-mobile/rooted" ] || "$root/scripts/fetch-nodejs-mobile.sh"
[ -d "$root/vendor/libgit2/Libgit2.xcframework" ] || "$root/scripts/build-libgit2.sh"
"$root/scripts/build-engine.sh"
cd "$root/app"
xcodegen generate --quiet
xcodebuild -project DshIOS.xcodeproj -scheme DshIOS -sdk iphonesimulator -destination "platform=iOS Simulator,name=$device" \
  -derivedDataPath build/DerivedData -skipPackagePluginValidation build -quiet
app="build/DerivedData/Build/Products/Debug-iphonesimulator/DshIOS.app"
xcrun simctl install "$device" "$app"
timeout "${1:-90}" xcrun simctl launch --console-pty --terminate-running-process "$device" com.wsw.dsh-ios || true
