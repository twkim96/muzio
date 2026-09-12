#!/usr/bin/env bash
set -euo pipefail

# VLC is distributed as platform-specific binary packages.  Keep the archives
# and extracted frameworks out of Git, but verify every archive before it is
# used so a local build cannot silently pick up another release.  macOS stays
# on the stable 3.7.3 package while iOS/iPadOS uses the official 4.0.0-a24
# package in its own directory.
export LC_ALL=C

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
THIRDPARTY="$ROOT/ios_app/ThirdParty"
DOWNLOAD_DIR="${VLCKIT_DOWNLOAD_DIR:-$THIRDPARTY/.downloads}"
TMP_ROOT="${TMPDIR:-/tmp}"
STAGING_DIR="$(mktemp -d "$TMP_ROOT/muzio-vlckit.XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT

MAC_VLCKIT_ARCHIVE_NAME="VLCKit-3.7.3-319ed2c0-79128878.tar.xz"
IOS_VLCKIT_ARCHIVE_NAME="VLCKit-4.0-20260831-1526.zip"
MAC_VLCKIT_URL="https://download.videolan.org/pub/cocoapods/prod/$MAC_VLCKIT_ARCHIVE_NAME"
IOS_VLCKIT_URL="https://download.videolan.org/cocoapods/unstable/$IOS_VLCKIT_ARCHIVE_NAME"
MAC_VLCKIT_SHA256="019afdae4e2e2d0f3ac325fac8f7ba0af25dca70b9d157df7d60db88e0be8e5d"
IOS_VLCKIT_SHA256="c61a42052ec4c1315325fba81f8893f4ccf639d92bf61dd1b3c37c3a2f26b8e3"

die() {
  echo "prepare-vlckit: $*" >&2
  exit 1
}

sha256() {
  local archive="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$archive" | awk '{ print $1 }'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$archive" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$archive" | awk '{ print $NF }'
  else
    die "shasum, sha256sum, or openssl is required to verify archives"
  fi
}

copy_tree() {
  local source="$1"
  local destination="$2"
  if command -v ditto >/dev/null 2>&1; then
    ditto "$source" "$destination"
  else
    cp -R "$source" "$destination"
  fi
}

archive_for() {
  local name="$1"
  local url="$2"
  local override_var="$3"
  local override="${!override_var:-}"
  local canonical="$DOWNLOAD_DIR/$name"
  local short_name="${name%%-*}"
  local local_validation_archive=""
  local candidate
  local candidates=("$canonical" "/tmp/muzio-vlc-validation/$name" "$TMP_ROOT/$name")

  if [[ "$name" == "$IOS_VLCKIT_ARCHIVE_NAME" ]]; then
    local_validation_archive="/tmp/muzio-vlc4-a24.zip"
    candidates+=("$local_validation_archive")
  else
    candidates+=("/tmp/muzio-vlc-validation/$short_name.tar.xz" "$TMP_ROOT/$short_name.tar.xz")
  fi

  if [[ -n "$override" ]]; then
    [[ -f "$override" ]] || die "$override_var does not point to a file: $override"
    printf '%s\n' "$override"
    return
  fi

  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  command -v curl >/dev/null 2>&1 || die "curl is required to download $url"
  mkdir -p "$DOWNLOAD_DIR"
  candidate="$canonical.part"
  rm -f "$candidate"
  echo "Downloading $url" >&2
  curl --fail --location --retry 3 --retry-delay 1 --proto '=https' --tlsv1.2 \
    --output "$candidate" "$url"
  mv "$candidate" "$canonical"
  printf '%s\n' "$canonical"
}

extract_archive() {
  local archive="$1"
  local extraction="$2"
  local framework_name="$3"
  local slices="$4"
  local member
  local members=()

  rm -rf "$extraction"
  mkdir -p "$extraction"
  case "$archive" in
    *.tar.xz)
      tar -xJf "$archive" -C "$extraction"
      ;;
    *.zip)
      # The 4.0.0-a24 ZIP contains tvOS, watchOS, visionOS, and macOS
      # artifacts too. Extract only the iOS framework slices and the root
      # manifest so preparation does not needlessly consume disk space.
      members+=("COPYING.txt" "$framework_name.xcframework/Info.plist")
      for member in $slices; do
        members+=("$framework_name.xcframework/$member/*")
      done
      unzip -q "$archive" "${members[@]}" \
        -x "$framework_name.xcframework/*/dSYMs/*" -d "$extraction"
      ;;
    *)
      die "unsupported archive format: $archive"
      ;;
  esac
}

verify_archive() {
  local archive="$1"
  local expected="$2"
  local actual
  actual="$(sha256 "$archive")"
  [[ "$actual" == "$expected" ]] || die "SHA-256 mismatch for $archive (expected $expected, got $actual)"
}

locate_framework() {
  local extraction="$1"
  local framework_name="$2"
  local framework
  framework="$(find "$extraction" -type d -name "$framework_name.xcframework" -print -quit)"
  [[ -n "$framework" ]] || die "archive did not contain $framework_name.xcframework"
  [[ -f "$framework/Info.plist" ]] || die "$framework is missing Info.plist"
  printf '%s\n' "$framework"
}

locate_notice() {
  local extraction="$1"
  local notice
  notice="$(find "$extraction" -type f \( -name COPYING.txt -o -name COPYING \) -print -quit)"
  [[ -n "$notice" ]] || die "archive did not contain an LGPL notice"
  printf '%s\n' "$notice"
}

install_name_for_mac() {
  local framework="$1"
  local binary="$framework/macos-arm64_x86_64/VLCKit.framework/VLCKit"
  local expected='@loader_path/../Frameworks/VLCKit.framework/Versions/A/VLCKit'
  [[ -f "$binary" ]] || die "VLCKit archive is missing the macos-arm64_x86_64 slice"

  # The official package already uses this app-relative ID.  Retain the
  # guard for mirrors or future package refreshes, where an absolute ID would
  # otherwise make the copied framework unloadable from Muzio.app.
  if command -v otool >/dev/null 2>&1 && command -v install_name_tool >/dev/null 2>&1; then
    local current
    current="$(otool -D "$binary" | tail -n 1)"
    if [[ "$current" != "$expected" ]]; then
      install_name_tool -id "$expected" "$binary"
    fi
  fi
}

prepare_one() {
  local archive="$1"
  local framework_name="$2"
  local slices="$3"
  local notice_name="$4"
  local destination="${5:-$THIRDPARTY/$framework_name.xcframework}"
  local extraction="$STAGING_DIR/$framework_name"
  local source_framework
  local source_notice
  local staged_framework="$STAGING_DIR/$framework_name.xcframework"
  local slice
  local source_binary
  local destination_binary
  local source_info_hash
  local destination_info_hash
  local framework_matches=true

  extract_archive "$archive" "$extraction" "$framework_name" "$slices"
  source_framework="$(locate_framework "$extraction" "$framework_name")"
  # Xcode requires every declared dSYM path to exist. The trimmed download
  # deliberately omits symbols/platforms; keep its manifest consistent too.
  python3 - "$source_framework" <<'PY_MANIFEST'
import pathlib, plistlib, sys
root = pathlib.Path(sys.argv[1])
path = root / 'Info.plist'
data = plistlib.loads(path.read_bytes())
libraries = []
for entry in data['AvailableLibraries']:
    directory = root / entry['LibraryIdentifier']
    if not (directory / entry['LibraryPath']).exists():
        continue
    for key in ('DebugSymbolsPath', 'BitcodeSymbolMapsPath'):
        if key in entry and not (directory / entry[key]).exists():
            del entry[key]
    libraries.append(entry)
data['AvailableLibraries'] = libraries
path.write_bytes(plistlib.dumps(data))
PY_MANIFEST
  for slice in $slices; do
    [[ -f "$source_framework/$slice/$framework_name.framework/$framework_name" ]] || \
      die "$framework_name archive is missing expected slice $slice"
  done
  source_notice="$(locate_notice "$extraction")"

  # A verified archive is not enough to trust an already-created output: a
  # stale or interrupted copy can still leave the expected paths present.
  # Compare the manifest and every platform binary before taking the cheaper
  # idempotent path.  This also repairs an output modified after preparation.
  if [[ ! -f "$destination/Info.plist" ]]; then
    framework_matches=false
  else
    source_info_hash="$(sha256 "$source_framework/Info.plist")"
    destination_info_hash="$(sha256 "$destination/Info.plist")"
    [[ "$source_info_hash" == "$destination_info_hash" ]] || framework_matches=false
    if find "$destination" -type d -name dSYMs -print -quit | grep -q .; then
      framework_matches=false
    fi
    local entry
    local entry_name
    local known_slice
    for entry in "$destination"/*; do
      entry_name="$(basename "$entry")"
      if [[ "$entry_name" == "Info.plist" ]]; then
        continue
      fi
      known_slice=false
      for slice in $slices; do
        if [[ "$entry_name" == "$slice" ]]; then
          known_slice=true
          break
        fi
      done
      [[ "$known_slice" == true ]] || framework_matches=false
    done
    for slice in $slices; do
      source_binary="$source_framework/$slice/$framework_name.framework/$framework_name"
      destination_binary="$destination/$slice/$framework_name.framework/$framework_name"
      if [[ ! -f "$destination_binary" ]] || [[ "$(sha256 "$source_binary")" != "$(sha256 "$destination_binary")" ]]; then
        framework_matches=false
      fi
    done
  fi

  if [[ "$framework_matches" != true ]]; then
    rm -rf "$staged_framework" "$destination"
    copy_tree "$source_framework" "$staged_framework"
    mkdir -p "$(dirname "$destination")"
    mv "$staged_framework" "$destination"
  fi

  mkdir -p "$THIRDPARTY/licenses"
  cp "$source_notice" "$THIRDPARTY/licenses/$notice_name"
}

mkdir -p "$THIRDPARTY" "$DOWNLOAD_DIR"
MAC_VLCKIT_ARCHIVE="$(archive_for "$MAC_VLCKIT_ARCHIVE_NAME" "$MAC_VLCKIT_URL" MAC_VLCKIT_ARCHIVE)"
IOS_VLCKIT_ARCHIVE="$(archive_for "$IOS_VLCKIT_ARCHIVE_NAME" "$IOS_VLCKIT_URL" IOS_VLCKIT_ARCHIVE)"
verify_archive "$MAC_VLCKIT_ARCHIVE" "$MAC_VLCKIT_SHA256"
verify_archive "$IOS_VLCKIT_ARCHIVE" "$IOS_VLCKIT_SHA256"

# Preserve a local, verified source cache when the supplied archive came from
# the validation staging directory or another caller-provided path.
if [[ "$MAC_VLCKIT_ARCHIVE" != "$DOWNLOAD_DIR/$MAC_VLCKIT_ARCHIVE_NAME" ]]; then
  cp "$MAC_VLCKIT_ARCHIVE" "$DOWNLOAD_DIR/$MAC_VLCKIT_ARCHIVE_NAME"
fi
if [[ "$IOS_VLCKIT_ARCHIVE" != "$DOWNLOAD_DIR/$IOS_VLCKIT_ARCHIVE_NAME" ]]; then
  cp "$IOS_VLCKIT_ARCHIVE" "$DOWNLOAD_DIR/$IOS_VLCKIT_ARCHIVE_NAME"
fi

prepare_one "$MAC_VLCKIT_ARCHIVE" VLCKit 'macos-arm64_x86_64' VLCKit-COPYING.txt
prepare_one "$IOS_VLCKIT_ARCHIVE" VLCKit 'ios-arm64_x86_64-simulator ios-arm64' VLCKit-iOS-COPYING.txt "$THIRDPARTY/VLCiOS/VLCKit.xcframework"
install_name_for_mac "$THIRDPARTY/VLCKit.xcframework"

echo "Prepared $THIRDPARTY/VLCKit.xcframework"
echo "Prepared $THIRDPARTY/VLCiOS/VLCKit.xcframework"
echo "Preserved LGPL notices in $THIRDPARTY/licenses"
