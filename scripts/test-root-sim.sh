#!/usr/bin/env bash
# Run native/root/test/conformance.mjs on the real NodeMobile, in a booted
# simulator and without the app. Runs twice, renaming the root in between: what
# an app update does to the container. SIM_DEVICE picks the simulator (default:
# the first booted one). Run it when Node or pnpm changes.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
device="${SIM_DEVICE:-$(xcrun simctl list devices booted | sed -nE 's/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p' | head -1)}"
[ -n "$device" ] || { echo "no booted simulator; boot one or set SIM_DEVICE" >&2; exit 1; }
[ -d "$root/vendor/nodejs-mobile/rooted" ] || "$root/scripts/fetch-nodejs-mobile.sh"
[ -d "$root/app/build/nodejs-project" ] || "$root/scripts/build-engine.sh"
out="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/dsh-root-XXXXXX")" && pwd -P)"
trap 'rm -rf "$out"' EXIT
slice="$root/vendor/nodejs-mobile/rooted/NodeMobile.xcframework/ios-arm64-simulator"
cc=(xcrun --sdk iphonesimulator clang -target arm64-apple-ios17.0-simulator -arch arm64 -O1 -std=gnu11 -D_DARWIN_C_SOURCE)
mkdir -p "$out/fw/DshRoot.framework" "$out/app/App.app"
cp -R "$slice/NodeMobile.framework" "$out/fw/"
"${cc[@]}" -dynamiclib "$root/native/root/root.c" -o "$out/fw/DshRoot.framework/DshRoot" \
  -install_name @rpath/DshRoot.framework/DshRoot -Wl,-reexport-lSystem
"${cc[@]}" "$root/native/root/test/harness.c" "$root/native/root/binding.c" -I "$root/vendor/nodejs-mobile/ios/include/node" \
  -o "$out/app/App.app/harness" -F "$out/fw" -framework DshRoot -framework NodeMobile -Wl,-rpath,"$out/fw"
cp -cR "$root/app/build/nodejs-project" "$out/app/App.app/nodejs-project"
cp "$root/native/root/test/conformance.mjs" "$out/app/App.app/nodejs-project/"
run() {
  mkdir -p "$out/container/$1"
  SIMCTL_CHILD_DSH_TEST_ROOT="$out/container/$1" SIMCTL_CHILD_DSH_TEST_BUNDLE="$out/app/App.app" SIMCTL_CHILD_DSH_TEST_CONTAINER="$out/container" \
    xcrun simctl spawn "$device" "$out/app/App.app/harness" \
      --import=file:///opt/dsh/nodejs-project/runtime/real-paths.mjs /opt/dsh/nodejs-project/conformance.mjs
}
echo "--- first run"
run root
mv "$out/container/root" "$out/container/moved"
echo "--- after the tree moved"
run moved
