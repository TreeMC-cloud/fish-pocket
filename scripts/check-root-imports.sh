#!/usr/bin/env bash
# What Node imports decides what native/root must cover. Compare NodeMobile's
# libSystem and std::filesystem imports with native/root/imports.txt: a new libc
# function that takes a path needs a definition in root.c, and a new
# std::filesystem entry can mean an fs function libc hooks cannot reach (see
# engine/runtime/real-paths.mjs). Also confirms both slices were pointed at DshRoot.
#   check-root-imports.sh           compare
#   check-root-imports.sh --update  rewrite the list, after reviewing the diff
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
list="$root/native/root/imports.txt"
framework="$root/vendor/nodejs-mobile/rooted/NodeMobile.xcframework"
[ -d "$framework" ] || "$root/scripts/fetch-nodejs-mobile.sh"
for binary in "$framework"/*/NodeMobile.framework/NodeMobile; do
  otool -L "$binary" | grep -q '@rpath/DshRoot.framework/DshRoot' || { echo "not pointed at DshRoot: $binary" >&2; exit 1; }
  ! otool -L "$binary" | grep -q libSystem || { echo "still links libSystem: $binary" >&2; exit 1; }
done
imports() {
  for binary in "$framework"/*/NodeMobile.framework/NodeMobile; do
    nm -um "$binary" | awk '/from DshRoot\)/ {print $3} /from libc\+\+\)/ && /__fs10filesystem/ {print $3}'
  done | LC_ALL=C sort -u
}
if [ "${1:-}" = "--update" ]; then
  imports > "$list"
  echo "wrote $(wc -l < "$list" | tr -d ' ') imports to $list"
elif ! diff <(imports) "$list"; then
  echo "NodeMobile's imports changed (lines with < are new). Hook any new path function in native/root/root.c, then run $0 --update." >&2
  exit 1
fi
