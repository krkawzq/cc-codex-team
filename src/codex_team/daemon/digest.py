"""Digest helpers for Codex notifications and thread items."""

from __future__ import annotations

import json as _json
import re
from pathlib import Path
from typing import Any

from codex_team.config import DigestCfg
from codex_team.schemas.turn_summary import DigestLine, DigestLineKind, TurnSummary, TurnTier

_FENCED = re.compile(r"```.*?```", re.DOTALL)


def _unwrap_item(item: Any) -> Any:
    return getattr(item, "root", item)


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    indicator = f" … (truncated, {len(text)} chars)"
    return text[: max(limit - len(indicator), 0)] + indicator


def _first_line(text: str) -> str:
    return text.splitlines()[0] if text else ""


def _tail_lines(text: str, n: int) -> str:
    lines = text.splitlines()
    return "\n".join(lines[-n:]) if lines else ""


def digest_item(item: Any, cfg: DigestCfg) -> DigestLine | None:
    item = _unwrap_item(item)
    item_type = getattr(item, "type", None)
    if item_type == "commandExecution":
        return _digest_command(item, cfg)
    if item_type == "fileChange":
        return _digest_file_change(item)
    if item_type == "agentMessage":
        return DigestLine(kind=DigestLineKind.agent_message, text=getattr(item, "text", "") or "")
    if item_type == "reasoning":
        if not cfg.reasoning_capture:
            return None
        summary = getattr(item, "summary", []) or []
        if isinstance(summary, list):
            text = " ".join(str(part) for part in summary if part)
        else:
            text = str(summary)
        return DigestLine(kind=DigestLineKind.agent_message, text=text)
    if item_type == "webSearch":
        return DigestLine(kind=DigestLineKind.web_search, text=getattr(item, "query", "") or "")
    if item_type in {"mcpToolCall", "dynamicToolCall"}:
        return _digest_tool_call(item)
    if item_type == "collabAgentToolCall":
        tool = getattr(item, "tool", "") or "subagent"
        return DigestLine(kind=DigestLineKind.collab_agent, text=f"subagent={tool}")
    return None


def _digest_command(item: Any, cfg: DigestCfg) -> DigestLine:
    raw = getattr(item, "command", "") or ""
    shown = _first_line(raw)
    if len(raw) > cfg.command_truncate_chars or "\n" in raw:
        shown = _truncate(shown, cfg.command_truncate_chars)
    exit_code = getattr(item, "exit_code", None)
    duration_ms = getattr(item, "duration_ms", None)
    stderr = getattr(item, "stderr", "") or ""
    stderr_tail = None
    if exit_code not in (None, 0):
        tail = _tail_lines(stderr, cfg.stderr_tail_lines_on_fail)
        stderr_tail = tail or None
    return DigestLine(
        kind=DigestLineKind.command,
        text=shown,
        exit_code=exit_code,
        duration_ms=duration_ms,
        stderr_tail=stderr_tail,
    )


def _digest_file_change(item: Any) -> DigestLine:
    changes = getattr(item, "changes", []) or []
    first = changes[0] if changes else None
    path = getattr(first, "path", "") if first else ""
    lines_added = getattr(first, "lines_added", 0) if first else 0
    lines_removed = getattr(first, "lines_removed", 0) if first else 0
    return DigestLine(
        kind=DigestLineKind.file_change,
        text=f"{path} (+{lines_added}/-{lines_removed})",
        path=path,
        lines_added=lines_added,
        lines_removed=lines_removed,
    )


def _digest_tool_call(item: Any) -> DigestLine:
    server = getattr(item, "server", "") or ""
    tool = getattr(item, "tool", "") or ""
    args = getattr(item, "args", "") or ""
    args_head = str(args)[:80] if args else ""
    label = f"{server}/{tool}" if server else tool
    text = f"{label}({args_head})" if args_head else label
    return DigestLine(kind=DigestLineKind.tool_call, text=text, tool_name=label)


def _has_question(message: str) -> bool:
    if not message:
        return False
    stripped = _FENCED.sub("", message).rstrip()
    return stripped.endswith("?")


def classify_tier(lines: list[DigestLine], *, status: str, final_message: str | None) -> TurnTier:
    if status not in {"ok", "completed"}:
        return TurnTier.attn
    if any(line.kind == DigestLineKind.command and line.exit_code not in (None, 0) for line in lines):
        return TurnTier.attn
    if _has_question(final_message or ""):
        return TurnTier.attn
    if any(line.kind == DigestLineKind.file_change for line in lines):
        return TurnTier.normal
    return TurnTier.trivial


def build_turn_summary(
    *,
    session: str,
    turn_id: str,
    elapsed_ms: int,
    status: str,
    lines: list[DigestLine],
    final_message: str | None,
    usage_last: int | None = None,
    usage_total: int | None = None,
    error_message: str | None = None,
    completed_at: str | None = None,
) -> TurnSummary:
    files_added = sum(line.lines_added or 0 for line in lines if line.kind == DigestLineKind.file_change)
    files_removed = sum(line.lines_removed or 0 for line in lines if line.kind == DigestLineKind.file_change)
    tier = classify_tier(lines, status=status, final_message=final_message)
    return TurnSummary(
        session=session,
        turn_id=turn_id,
        elapsed_ms=elapsed_ms,
        status=status,
        tier=tier,
        final_message=final_message,
        files_added=files_added,
        files_removed=files_removed,
        lines=lines,
        usage_last_tokens=usage_last,
        usage_total_tokens=usage_total,
        error_message=error_message,
        completed_at=completed_at,
    )


def _format_line(line: DigestLine) -> str:
    if line.kind == DigestLineKind.command:
        exit_code = line.exit_code
        duration_ms = line.duration_ms or 0
        status = "ok" if exit_code == 0 else f"FAIL exit={exit_code}"
        suffix = f"\n    stderr: {line.stderr_tail}" if line.stderr_tail else ""
        return f"- [{status} {duration_ms}ms] {line.text}{suffix}"
    if line.kind == DigestLineKind.file_change:
        return f"- M {line.path} (+{line.lines_added}/-{line.lines_removed})"
    if line.kind == DigestLineKind.agent_message:
        return f"- msg: {line.text}"
    if line.kind == DigestLineKind.tool_call:
        return f"- tool: {line.text}"
    if line.kind == DigestLineKind.web_search:
        return f"- search: {line.text}"
    return f"- {line.text}"


def write_history_md(path: Path, summary: TurnSummary) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    parts = [
        f"\n## Turn {summary.turn_id} · {summary.elapsed_ms}ms · status={summary.status} · tier={summary.tier.value}\n"
    ]
    file_lines = [line for line in summary.lines if line.kind == DigestLineKind.file_change]
    if file_lines:
        parts.append("\n### File changes\n")
        parts.append("\n".join(_format_line(line) for line in file_lines))
        parts.append("\n")
    command_lines = [line for line in summary.lines if line.kind == DigestLineKind.command]
    if command_lines:
        parts.append("\n### Commands\n")
        parts.append("\n".join(_format_line(line) for line in command_lines))
        parts.append("\n")
    message_lines = [line for line in summary.lines if line.kind == DigestLineKind.agent_message]
    if message_lines:
        parts.append("\n### Messages\n")
        parts.append("\n".join(_format_line(line) for line in message_lines))
        parts.append("\n")
    if summary.final_message:
        quoted = summary.final_message.replace("\n", "\n> ")
        parts.append("\n### Final answer\n")
        parts.append(f"> {quoted}\n")
    with path.open("a", encoding="utf-8") as handle:
        handle.write("".join(parts))


def write_turns_jsonl(path: Path, summary: TurnSummary) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(summary.model_dump_json() + "\n")
