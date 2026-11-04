#!/usr/bin/env bash
# Build native/git as a Node addon for this Mac (vendor/libgit2/macos/dsh_git.node),
# so engine tests run git against the same C the app links. The app compiles
# the same sources itself (app/project.yml) with DSH_GIT_LINKED.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
lib="$root/vendor/libgit2/macos"
node_include="$root/vendor/nodejs-mobile/ios/include/node"
[ -f "$lib/lib/libgit2.a" ] || "$root/scripts/build-libgit2.sh"
[ -d "$node_include" ] || "$root/scripts/fetch-nodejs-mobile.sh"
clang -std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers -Werror=implicit-function-declaration \
  -mmacosx-version-min=13.0 -bundle -undefined dynamic_lookup \
  -I "$node_include" -I "$lib/include" \
  "$root"/native/git/*.c "$lib/lib/libgit2.a" \
  -framework CoreFoundation -framework Security -lz -liconv \
  -o "$lib/dsh_git.node"
echo "addon: $lib/dsh_git.node"
