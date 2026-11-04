#!/usr/bin/env bash
# Build native/image as a Node addon for this Mac (vendor/image/dsh_image.node),
# so engine tests run the sharp stand-in against the same C the app links. The
# app compiles the same source itself (app/project.yml) with DSH_IMAGE_LINKED.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
lib="$root/vendor/image"
node_include="$root/vendor/nodejs-mobile/ios/include/node"
[ -d "$node_include" ] || "$root/scripts/fetch-nodejs-mobile.sh"
mkdir -p "$lib"
clang -std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers -Werror=implicit-function-declaration \
  -mmacosx-version-min=13.0 -bundle -undefined dynamic_lookup \
  -I "$node_include" \
  "$root"/native/image/*.c \
  -framework CoreFoundation -framework CoreGraphics -framework ImageIO \
  -o "$lib/dsh_image.node"
echo "addon: $lib/dsh_image.node"
