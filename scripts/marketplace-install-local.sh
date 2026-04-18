#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
claude plugin marketplace add "${PLUGIN_ROOT}" >/dev/null || true
exec claude plugin install codex-team@cc-codex-team
