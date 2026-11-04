#!/usr/bin/env bash
# Download the pinned nodejs-mobile iOS build (NodeMobile.xcframework, Node 24)
# into vendor/nodejs-mobile/ios, checked against its sha256, and make the copy the
# app links, vendor/nodejs-mobile/rooted: its libSystem dependency points at
# DshRoot (native/root), which re-exports libSystem, so dyld binds Node's path
# calls to the engine's filesystem view. That one load command is all that changes.
set -euo pipefail
version="24.20.0-0"
sha256="f97c5f368f5982fdc062b0f97d96d7696f94dbaf286fbd0d3c515b596088bca8"
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/vendor/nodejs-mobile"
zip="$dir/nodejs-mobile-ios-$version.zip"
mkdir -p "$dir"
if [ ! -f "$zip" ]; then
  curl -fL --retry 3 -o "$zip.part" "https://github.com/digidem/nodejs-mobile/releases/download/v$version/nodejs-mobile-ios-$version.zip"
  mv "$zip.part" "$zip"
fi
echo "$sha256  $zip" | shasum -a 256 -c -
rm -rf "$dir/ios"
unzip -q "$zip" -d "$dir/ios"
rm -rf "$dir/rooted"
mkdir -p "$dir/rooted"
cp -R "$dir/ios/NodeMobile.xcframework" "$dir/rooted/"
for binary in "$dir"/rooted/NodeMobile.xcframework/*/NodeMobile.framework/NodeMobile; do
  install_name_tool -change /usr/lib/libSystem.B.dylib @rpath/DshRoot.framework/DshRoot "$binary" 2>/dev/null
  codesign --force --sign - "$binary" 2>/dev/null
done
echo "NodeMobile.xcframework ready: $dir/ios, $dir/rooted"
