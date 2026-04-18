from codex_team.schemas.registry import RegistryEntry, SessionStatus
from codex_team.schemas.turn_summary import DigestLine, DigestLineKind, TurnSummary, TurnTier


def test_registry_entry_defaults_and_serialize():
    entry = RegistryEntry(
        name="A",
        thread_id="thr_1",
        cwd="/x",
        model="gpt-5.4",
        sandbox="danger_full_access",
    )
    assert entry.status == SessionStatus.idle
    assert entry.queue_length == 0
    assert entry.model_dump(mode="json")["status"] == "idle"


def test_digest_line_kinds():
    command = DigestLine(kind=DigestLineKind.command, text="ls -la", exit_code=0, duration_ms=120)
    message = DigestLine(kind=DigestLineKind.agent_message, text="hello")
    assert command.exit_code == 0
    assert message.exit_code is None


def test_turn_summary_tier_enum():
    summary = TurnSummary(
        session="A",
        turn_id="tr_1",
        elapsed_ms=1200,
        status="ok",
        tier=TurnTier.trivial,
        final_message=None,
        files_added=0,
        files_removed=0,
        lines=[],
    )
    assert summary.tier == TurnTier.trivial
    assert summary.model_dump(mode="json")["tier"] == "trivial"
