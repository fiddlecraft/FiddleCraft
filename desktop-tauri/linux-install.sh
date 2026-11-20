#!/bin/sh
# Installs FiddleCraft for the current user only (no admin password needed)
set -e
here=$(cd "$(dirname "$0")" && pwd)
bin="$HOME/.local/bin"
share="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$bin" "$share/applications" "$share/icons/hicolor/512x512/apps" "$share/mime/packages"
cp "$here/fiddlecraft" "$bin/fiddlecraft"
cp "$here/fiddlecraft.png" "$share/icons/hicolor/512x512/apps/fiddlecraft.png"
cp "$here/fiddlecraft-mime.xml" "$share/mime/packages/fiddlecraft.xml"
sed "s|^Exec=fiddlecraft|Exec=$bin/fiddlecraft|" "$here/FiddleCraft.desktop" > "$share/applications/FiddleCraft.desktop"
update-mime-database "$share/mime" 2>/dev/null || true
update-desktop-database "$share/applications" 2>/dev/null || true
echo "FiddleCraft is installed. Find it in your app menu, or run: $bin/fiddlecraft"
