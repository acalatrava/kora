#!/usr/bin/env bash
# Merges ~/.kora/config/workspaces/<id> into ~/.kora/workspaces/<id>.
# Uses rsync --ignore-existing so files already in the destination are not overwritten.
set -euo pipefail

OLD_BASE="${KORA_HOME:-$HOME/.kora}/config/workspaces"
NEW_BASE="${KORA_HOME:-$HOME/.kora}/workspaces"

if [[ ! -d "$OLD_BASE" ]]; then
  echo "Nothing to migrate: $OLD_BASE does not exist."
  exit 0
fi

shopt -s nullglob
for id in "$OLD_BASE"/*; do
  [[ -d "$id" ]] || continue
  ws=$(basename "$id")
  echo ">>> Merging $ws ..."
  mkdir -p "$NEW_BASE/$ws"
  rsync -a --ignore-existing "$id/" "$NEW_BASE/$ws/"
  echo ">>> Done $ws"
done

exit 0

echo "Removing old workspace dirs under config/workspaces ..."
for id in "$OLD_BASE"/*; do
  [[ -d "$id" ]] || continue
  ws=$(basename "$id")
  rm -rf "$id"
  echo "Removed $OLD_BASE/$ws"
done

rmdir "$OLD_BASE" 2>/dev/null || true
echo "Migration finished. Unified path: $NEW_BASE/<workspace-id>/"
