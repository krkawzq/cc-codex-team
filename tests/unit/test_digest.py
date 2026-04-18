import json
from pathlib import Path

from codex_team.config import DigestCfg
from codex_team.daemon.digest import (
    build_turn_summary,
    classify_tier,
    digest_item,
    write_history_md,
    write_turns_jsonl,
)
from codex_team.schemas.turn_summary import DigestLine, DigestLineKind, TurnTier


class _FakeCommand:
    def __init__(self, command: str, exit_code: int, duration_ms: int, stderr: str = ""):
        self.type = "commandExecution"
        self.command = command
        self.exit_code = exit_code
        self.duration_ms = duration_ms
        self.stderr = stderr
        self.status = "completed" if exit_code == 0 else "failed"


class _FakeFileChange:
    def __init__(self, path: str, added: int, removed: int):
        self.type = "fileChange"
        self.changes = [type("C", (), {"path": path, "lines_added": added, "lines_removed": removed})]
        self.status = "completed"


class _FakeAgentMessage:
    def __init__(self, text: str, phase: str | None = None):
        self.type = "agentMessage"
        self.text = text
        self.phase = phase


class _FakeReasoning:
    type = "reasoning"
    summary = ["internal rambling"]


class _FakeWebSearch:
    type = "webSearch"
    query = "how to fastmath"


def test_command_exec_short_is_not_truncated():
    line = digest_item(_FakeCommand("ls -la", 0, 90), DigestCfg())
    assert line.kind == DigestLineKind.command
    assert line.text == "ls -la"
    assert line.exit_code == 0
    assert line.duration_ms == 90


def test_command_exec_long_is_truncated():
    cfg = DigestCfg(command_truncate_chars=30)
    long_cmd = "pytest tests/ -k very_long_name --some-flag --another-flag"
    line = digest_item(_FakeCommand(long_cmd, 0, 1000), cfg)
    assert len(line.text) <= 60
    assert "truncated" in line.text


def test_failing_command_attaches_stderr_tail():
    cfg = DigestCfg(stderr_tail_lines_on_fail=3)
    stderr = "\n".join(f"line{i}" for i in range(10))
    line = digest_item(_FakeCommand("pytest", 1, 500, stderr=stderr), cfg)
    assert line.exit_code == 1
    assert line.stderr_tail.splitlines() == ["line7", "line8", "line9"]


def test_file_change_yields_path_and_counts():
    line = digest_item(_FakeFileChange("src/x.py", 10, 2), DigestCfg())
    assert line.kind == DigestLineKind.file_change
    assert line.path == "src/x.py"
    assert line.lines_added == 10
    assert line.lines_removed == 2


def test_agent_message_returns_full_text():
    line = digest_item(_FakeAgentMessage("hello world", phase="final_answer"), DigestCfg())
    assert line.kind == DigestLineKind.agent_message
    assert line.text == "hello world"


def test_reasoning_is_dropped_by_default():
    assert digest_item(_FakeReasoning(), DigestCfg()) is None


def test_reasoning_kept_when_capture_enabled():
    line = digest_item(_FakeReasoning(), DigestCfg(reasoning_capture=True))
    assert line.kind == DigestLineKind.agent_message
    assert "internal rambling" in line.text


def test_web_search_yields_query():
    line = digest_item(_FakeWebSearch(), DigestCfg())
    assert line.kind == DigestLineKind.web_search
    assert line.text == "how to fastmath"


def test_tier_trivial_no_files_no_failures():
    tier = classify_tier([DigestLine(kind=DigestLineKind.command, text="ls", exit_code=0)], status="ok", final_message="done")
    assert tier == TurnTier.trivial


def test_tier_normal_with_files():
    tier = classify_tier(
        [DigestLine(kind=DigestLineKind.file_change, text="x.py", path="x.py", lines_added=1, lines_removed=0)],
        status="ok",
        final_message="done",
    )
    assert tier == TurnTier.normal


def test_tier_attn_failing_command():
    tier = classify_tier([DigestLine(kind=DigestLineKind.command, text="pytest", exit_code=1)], status="ok", final_message="done")
    assert tier == TurnTier.attn


def test_tier_attn_question_in_final():
    assert classify_tier([], status="ok", final_message="Should I relax tolerance?") == TurnTier.attn


def test_tier_attn_question_inside_fenced_ignored():
    message = "Here is code:\n```\nwhat?\n```\nAll done."
    assert classify_tier([], status="ok", final_message=message) == TurnTier.trivial


def test_tier_attn_turn_failed():
    assert classify_tier([], status="failed", final_message=None) == TurnTier.attn


def test_build_turn_summary_counts_files():
    lines = [
        DigestLine(kind=DigestLineKind.file_change, text="a", path="a", lines_added=5, lines_removed=1),
        DigestLine(kind=DigestLineKind.file_change, text="b", path="b", lines_added=0, lines_removed=2),
        DigestLine(kind=DigestLineKind.command, text="ls", exit_code=0),
    ]
    summary = build_turn_summary(
        session="A",
        turn_id="t1",
        elapsed_ms=1000,
        status="ok",
        lines=lines,
        final_message="ok",
        usage_last=100,
        usage_total=1000,
    )
    assert summary.files_added == 5
    assert summary.files_removed == 3
    assert summary.tier == TurnTier.normal


def test_write_history_md_appends(tmp_path: Path):
    summary_a = build_turn_summary(
        session="A",
        turn_id="t1",
        elapsed_ms=1200,
        status="ok",
        lines=[DigestLine(kind=DigestLineKind.command, text="ls", exit_code=0, duration_ms=5)],
        final_message="done",
    )
    summary_b = build_turn_summary(
        session="A",
        turn_id="t2",
        elapsed_ms=2400,
        status="ok",
        lines=[DigestLine(kind=DigestLineKind.agent_message, text="hi")],
        final_message="hi",
    )
    history = tmp_path / "history.md"
    write_history_md(history, summary_a)
    write_history_md(history, summary_b)
    content = history.read_text("utf-8")
    assert "## Turn t1" in content
    assert "## Turn t2" in content
    assert content.count("## Turn ") == 2


def test_write_turns_jsonl_appends(tmp_path: Path):
    summary = build_turn_summary(session="A", turn_id="t1", elapsed_ms=1000, status="ok", lines=[], final_message=None)
    path = tmp_path / "turns.jsonl"
    write_turns_jsonl(path, summary)
    write_turns_jsonl(path, summary)
    lines = path.read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["turn_id"] == "t1"
