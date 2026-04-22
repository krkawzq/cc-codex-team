#!/usr/bin/env bash
# Uninstall the locally-installed codex-team plugin from Claude Code.
# Does NOT touch daemon data (use dev-reset.sh for that).
set -euo pipefail

exec claude plugin uninstall codex-team
