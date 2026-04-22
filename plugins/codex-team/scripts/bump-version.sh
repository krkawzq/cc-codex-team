#!/usr/bin/env bash
set -euo pipefail

skip_dirty_check=0
if [[ "${1:-}" == "-y" ]]; then
  skip_dirty_check=1
  shift
fi

if [[ $# -ne 1 ]]; then
  echo "usage: $0 [-y] <version>" >&2
  exit 1
fi

new_version="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$plugin_dir/../.." && pwd)"
package_json="$plugin_dir/package.json"
plugin_json="$plugin_dir/.claude-plugin/plugin.json"

dirty="$(git -C "$repo_root" status --porcelain)"
if [[ -n "$dirty" && $skip_dirty_check -ne 1 ]]; then
  echo "warning: git tree is not clean; rerun with -y to continue" >&2
  exit 1
fi
if [[ -n "$dirty" && $skip_dirty_check -eq 1 ]]; then
  echo "warning: proceeding with a dirty git tree" >&2
fi

update_version() {
  node - "$1" "$new_version" <<'NODE'
const fs = require("node:fs");
const [filePath, version] = process.argv.slice(2);
const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
json.version = version;
fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
NODE
}

update_version "$package_json"
update_version "$plugin_json"

(
  cd "$plugin_dir"
  npm run build
)

echo "updated release artifacts for $new_version:"
git -C "$repo_root" status --short -- \
  "plugins/codex-team/package.json" \
  "plugins/codex-team/.claude-plugin/plugin.json" \
  "plugins/codex-team/dist/main.js"
echo
echo "next: git add plugins/codex-team/package.json plugins/codex-team/.claude-plugin/plugin.json plugins/codex-team/dist/main.js && git commit -m \"release: $new_version\""
