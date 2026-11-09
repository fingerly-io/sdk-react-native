#!/bin/bash
#
# Puts Fingerly.xcframework in <pod root>/Frameworks. Run by the podspec.
#
#   fetch-fingerly-xcframework.sh <version> <sha256> <pod root>
#
# The release writes the checksum of the published zip into fingerly-binary.json
# before packing, so a package from npm only ever installs the exact binary it
# was released against. The checksum is empty only in a git checkout.
#
# Stdout stays silent because `pod ipc spec` prints its JSON there.
set -euo pipefail

version="$1"
sha256="$2"
dest="$3/Frameworks"
stamp="$dest/.fingerly-binary"
wanted="$version $sha256"

if [ -d "$dest/Fingerly.xcframework" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$wanted" ]; then
  exit 0
fi

url="https://maven.fingerly.io/ios/Fingerly-$version.xcframework.zip"
work="$(mktemp -d "${TMPDIR:-/tmp}/fingerly-xcframework.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if ! curl --fail --silent --show-error --location --proto '=https' --retry 3 --output "$work/sdk.zip" "$url"; then
  echo "error: could not download $url" >&2
  exit 1
fi

if [ -n "$sha256" ]; then
  actual="$(shasum -a 256 "$work/sdk.zip" | cut -d' ' -f1)"
  if [ "$actual" != "$sha256" ]; then
    echo "error: $url has checksum $actual, expected $sha256" >&2
    exit 1
  fi
else
  echo "warning: no checksum recorded, $url was not verified (expected only in a git checkout)" >&2
fi

unzip -q "$work/sdk.zip" -d "$work/expanded"
if [ ! -d "$work/expanded/Fingerly.xcframework" ]; then
  echo "error: $url does not contain Fingerly.xcframework" >&2
  exit 1
fi

rm -rf "$dest"
mkdir -p "$dest"
mv "$work/expanded/Fingerly.xcframework" "$dest/"
printf '%s' "$wanted" > "$stamp"
