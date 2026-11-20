#!/usr/bin/env bash
# Copies the built packages into release/ with the names the README lists, and on Linux makes the
# small .tar.gz download. Run after "npm run dist:<platform>". Uses CARGO_TARGET_DIR if set.
#   ./package.sh                 # this computer's own build
#   ./package.sh <rust-target>   # a build made with --target (for example aarch64-pc-windows-msvc)
set -euo pipefail
cd "$(dirname "$0")"
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
target_dir="${CARGO_TARGET_DIR:-target}"
triple="${1:-}"
out="$target_dir/${triple:+$triple/}release"
bundle="$out/bundle"
mkdir -p release
shopt -s nullglob

copy() { # copy <glob> <new name>, failing loudly if the build is missing
  local files=($1)
  if [ ${#files[@]} -eq 0 ]; then echo "missing: $1" >&2; exit 1; fi
  cp "${files[0]}" "release/$2"
}

case "$(uname -s)" in
  Linux)
    case "$(uname -m)" in
      x86_64) arch=x86_64; deb=amd64 ;;
      aarch64 | arm64) arch=arm64; deb=arm64 ;;
      *) arch=$(uname -m); deb=$arch ;;
    esac
    copy "$bundle/appimage/*.AppImage" "FiddleCraft-${version}-${arch}.AppImage"
    copy "$bundle/deb/*.deb" "FiddleCraft-${version}-linux-${deb}.deb"
    copy "$bundle/rpm/*.rpm" "FiddleCraft-${version}-linux-${arch}.rpm"

    # the small download: the program plus menu entry, using the computer's own WebKitGTK
    work=$(mktemp -d)
    dir="$work/FiddleCraft-${version}"
    mkdir -p "$dir"
    cp "$out/fiddlecraft" "$dir/fiddlecraft"
    cp icons/icon.png "$dir/fiddlecraft.png"
    cp fiddlecraft-mime.xml "$dir/fiddlecraft-mime.xml"
    sed -e 's/{{categories}}/Graphics;/' -e 's/{{comment}}/Free, open-source 3D design for everyone/' \
        -e 's/{{exec}}/fiddlecraft/g' -e 's/{{icon}}/fiddlecraft/' -e 's/{{name}}/FiddleCraft/' \
        -e 's|{{mime_type}}|application/x-fiddlecraft|' -e '/{{#if mime_type}}/d' -e '/{{\/if}}/d' \
        fiddlecraft.desktop > "$dir/FiddleCraft.desktop"
    cp linux-README.txt "$dir/README.txt"
    cp linux-install.sh "$dir/install.sh"
    chmod +x "$dir/fiddlecraft" "$dir/install.sh"
    tar czf "release/FiddleCraft-${version}-linux-${arch}.tar.gz" -C "$work" "FiddleCraft-${version}"
    ;;
  Darwin)
    copy "$bundle/dmg/*.dmg" "FiddleCraft-${version}-mac-universal.dmg"
    ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    case "$triple" in
      aarch64*) arch=arm64 ;;
      *) arch=x64 ;;
    esac
    copy "$bundle/nsis/*-setup.exe" "FiddleCraft-Setup-${version}-${arch}.exe"
    # the program on its own runs without installing (Windows 10 and 11 already have WebView2)
    copy "$out/fiddlecraft.exe" "FiddleCraft-Portable-${version}-${arch}.exe"
    ;;
esac
ls -la release
