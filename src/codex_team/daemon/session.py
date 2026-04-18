"""Session and SessionFactory."""

from __future__ import annotations

import asyncio
import datetime as dt
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from codex_team.config import (
    Config,
    normalize_approval_policy,
    normalize_sandbox_mode,
    resolve_codex_bin,
)
from codex_team.daemon.compaction import CompactionMonitor
from codex_team.daemon.digest import build_turn_summary, digest_item, write_history_md, write_turns_jsonl
from codex_team.daemon.event_bus import EventBus
from codex_team.daemon.queue import OverflowPolicy, PendingSend, SendQueue
from codex_team.daemon.registry import RegistryStore
from codex_team.errors import InvalidRequest, SessionExists, SessionNotFound
from codex_team.paths import session_dir
from codex_team.schemas.registry import RegistryEntry, SessionStatus
from codex_team.schemas.turn_summary import DigestLine, DigestLineKind, TurnTier

try:  # pragma: no cover - exercised in integration
    from codex_app_server import AppServerConfig, AsyncCodex, TextInput
except Exception:  # noqa: BLE001
    AppServerConfig = None
    AsyncCodex = None
    TextInput = None

CodexFactory = Callable[..., object]


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _normalize_status(status: Any) -> str:
    if status is None:
        return "unknown"
    value = getattr(status, "value", status)
    return str(value)


def _error_message(error: Any) -> str | None:
    if error is None:
        return None
    message = getattr(error, "message", None)
    if message:
        return str(message)
    return str(error)


def _make_text_input(text: str) -> Any:
    if TextInput is None:
        return text
    return TextInput(text)


def _sdk_sync_client(codex: object) -> object | None:
    client = getattr(codex, "_client", None)
    if client is None:
        return None
    sync = getattr(client, "_sync", None)
    return sync or client


def _app_server_pid(codex: object) -> int | None:
    sync = _sdk_sync_client(codex)
    if sync is None:
        return None
    proc = getattr(sync, "_proc", None)
    return getattr(proc, "pid", None)


def _stderr_lines_snapshot(codex: object) -> list[str]:
    sync = _sdk_sync_client(codex)
    if sync is None:
        return []
    stderr_lines = getattr(sync, "_stderr_lines", None)
    if stderr_lines is None:
        return []
    try:
        return list(stderr_lines)
    except TypeError:
        return []


class Session:
    def __init__(
        self,
        *,
        name: str,
        cfg: Config,
        data_dir: Path,
        registry: RegistryStore,
        event_bus: EventBus,
        compaction: CompactionMonitor | None,
        codex: object,
        thread: object,
    ) -> None:
        self._name = name
        self._cfg = cfg
        self._data_dir = data_dir
        self._registry = registry
        self._event_bus = event_bus
        self._compaction = compaction
        self._codex = codex
        self._thread = thread
        self._queue = SendQueue(
            max_size=cfg.queue.max_per_session,
            policy=OverflowPolicy(cfg.queue.overflow_policy),
        )
        self._active_turn: object | None = None
        self._closed = False
        self._running = False
        self._state_lock = asyncio.Lock()
        self._stderr_flushed_count = 0

    @property
    def name(self) -> str:
        return self._name

    async def send(
        self,
        text: str,
        *,
        wait: bool = False,
        overrides: dict[str, Any] | None = None,
    ) -> str | dict[str, Any]:
        if self._closed:
            raise SessionNotFound(self._name)
        placeholder_id = f"pending-{uuid.uuid4().hex[:8]}"
        wait_future: asyncio.Future[dict[str, Any]] | None = None
        if wait:
            wait_future = asyncio.get_running_loop().create_future()
        async with self._state_lock:
            if self._running:
                overflowed = self._queue.enqueue(
                    PendingSend(id=placeholder_id, text=text, wait_future=wait_future, overrides=overrides)
                )
                self._registry.update(self._name, queue_length=len(self._queue))
                if overflowed:
                    self._event_bus.publish(
                        "events",
                        {
                            "kind": "queue-overflow",
                            "session": self._name,
                            "policy": self._cfg.queue.overflow_policy,
                        },
                    )
            else:
                self._running = True
                self._registry.update(self._name, status=SessionStatus.running)
                asyncio.create_task(self._run_turn(text, wait_future, overrides))
        if wait and wait_future is not None:
            return await wait_future
        return placeholder_id

    async def interrupt(self) -> None:
        if self._active_turn is not None:
            await self._active_turn.interrupt()

    async def kill(self, *, reason: str = "killed") -> None:
        sync = _sdk_sync_client(self._codex)
        if sync is not None:
            proc = getattr(sync, "_proc", None)
            if proc is not None:
                kill = getattr(proc, "kill", None)
                if callable(kill):
                    kill()
        await self._shutdown_transport()
        self._registry.update(self._name, status=SessionStatus.errored, app_server_pid=None, error_message=reason)

    async def ack_error(self) -> None:
        self._registry.update(self._name, status=SessionStatus.idle, error_message=None)

    async def compact(self) -> None:
        self._registry.update(self._name, status=SessionStatus.compacting)
        await self._thread.compact()
        if self._compaction is not None:
            self._compaction.clear(self._name)
        self._registry.update(self._name, status=SessionStatus.idle)

    def snapshot_queue(self) -> list[PendingSend]:
        return self._queue.snapshot()

    def snapshot_queue_json(self) -> list[dict[str, Any]]:
        return [
            {
                "id": item.id,
                "text": item.text,
                "has_waiter": item.wait_future is not None,
                "overrides": item.overrides or {},
            }
            for item in self._queue.snapshot()
        ]

    def dump_state(self) -> dict[str, Any]:
        entry = self._registry.get(self._name).model_dump(mode="json")
        return {
            "session": entry,
            "queue": self.snapshot_queue_json(),
            "transport_alive": self.is_transport_alive(),
            "stderr_tail": self.stderr_tail(limit=20),
            "history_path": str(session_dir(self._data_dir, self._name) / "history.md"),
            "turns_path": str(session_dir(self._data_dir, self._name) / "turns.jsonl"),
        }

    def clear_queue(self) -> None:
        self._queue.clear()
        self._registry.update(self._name, queue_length=0)

    def drop_oldest(self) -> PendingSend | None:
        dropped = self._queue.drop_oldest()
        self._registry.update(self._name, queue_length=len(self._queue))
        return dropped

    async def close(self) -> None:
        self._closed = True
        await self._shutdown_transport()
        self._registry.update(self._name, status=SessionStatus.closed, app_server_pid=None)

    async def shutdown(self) -> None:
        await self._shutdown_transport()
        current = self._registry.get(self._name)
        if current.status == SessionStatus.closed:
            return
        updated_status = SessionStatus.errored if current.error_message else SessionStatus.idle
        self._registry.update(self._name, status=updated_status, app_server_pid=None)

    async def health_check(self) -> None:
        reader = getattr(self._thread, "read", None)
        if reader is None:
            return
        await reader(include_turns=False)

    def is_transport_alive(self) -> bool:
        sync = _sdk_sync_client(self._codex)
        if sync is None:
            return True
        proc = getattr(sync, "_proc", None)
        if proc is None:
            return False
        poll = getattr(proc, "poll", None)
        if callable(poll):
            return poll() is None
        return True

    def stderr_tail(self, *, limit: int = 40) -> str:
        lines = _stderr_lines_snapshot(self._codex)
        if not lines:
            return ""
        return "\n".join(lines[-limit:])

    async def _shutdown_transport(self) -> None:
        self._persist_stderr_log()
        close = getattr(self._codex, "close", None)
        if close is not None:
            await close()

    def _persist_stderr_log(self) -> None:
        lines = _stderr_lines_snapshot(self._codex)
        if not lines:
            return
        if self._stderr_flushed_count > len(lines):
            self._stderr_flushed_count = 0
        pending = lines[self._stderr_flushed_count :]
        if not pending:
            return
        path = session_dir(self._data_dir, self._name) / "app-server.stderr.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write("\n".join(pending) + "\n")
        self._stderr_flushed_count = len(lines)

    async def _run_turn(
        self,
        text: str,
        wait_future: asyncio.Future[dict[str, Any]] | None,
        overrides: dict[str, Any] | None,
    ) -> None:
        lines: list[DigestLine] = []
        final_message: str | None = None
        status = "completed"
        error_message: str | None = None
        turn_id = "unknown"
        usage_last: int | None = None
        usage_total: int | None = None
        started = time.perf_counter()
        self._registry.update(self._name, last_prompt_text=text)
        try:
            turn = await self._thread.turn(_make_text_input(text), **(overrides or {}))
            self._active_turn = turn
            turn_id = getattr(turn, "id", turn_id)
            async for event in turn.stream():
                method = getattr(event, "method", "")
                payload = getattr(event, "payload", None)
                if method == "item/completed":
                    item = getattr(payload, "item", None)
                    if item is None:
                        continue
                    line = digest_item(item, self._cfg.digest)
                    if line is not None:
                        lines.append(line)
                        if line.kind == DigestLineKind.agent_message:
                            phase = getattr(getattr(payload, "item", item), "phase", None)
                            if phase == "final_answer" or phase is None:
                                final_message = line.text
                elif method in {"thread/tokenUsageUpdated", "thread/tokenUsage/updated"}:
                    usage = getattr(payload, "token_usage", None) or getattr(payload, "tokenUsage", None)
                    if usage is not None:
                        last = getattr(usage, "last", None)
                        total = getattr(usage, "total", None)
                        usage_last = getattr(last, "total_tokens", None) or getattr(last, "totalTokens", None)
                        usage_total = getattr(total, "total_tokens", None) or getattr(total, "totalTokens", None)
                elif method == "turn/completed":
                    turn_obj = getattr(payload, "turn", None)
                    if turn_obj is not None:
                        turn_id = getattr(turn_obj, "id", turn_id)
                        status = _normalize_status(getattr(turn_obj, "status", status))
                        error_message = _error_message(getattr(turn_obj, "error", None))
        except Exception as exc:  # noqa: BLE001
            status = "errored"
            error_message = str(exc)
        finally:
            self._active_turn = None

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        final_status = "ok" if status in {"completed", "ok"} else status
        completed_at = _now_iso()
        summary = build_turn_summary(
            session=self._name,
            turn_id=turn_id,
            elapsed_ms=elapsed_ms,
            status=final_status,
            lines=lines,
            final_message=final_message,
            usage_last=usage_last,
            usage_total=usage_total,
            error_message=error_message,
            completed_at=completed_at,
        )

        session_path = session_dir(self._data_dir, self._name)
        if self._cfg.digest.history_md_enabled:
            write_history_md(session_path / "history.md", summary)
        if self._cfg.digest.turns_jsonl_enabled:
            write_turns_jsonl(session_path / "turns.jsonl", summary)

        if usage_total is not None and self._compaction is not None:
            await self._compaction.observe_usage(self._name, usage_total)

        self._persist_stderr_log()
        registry_status = SessionStatus.idle if final_status == "ok" else SessionStatus.errored
        self._registry.update(
            self._name,
            status=registry_status,
            last_turn_id=turn_id,
            last_turn_ended_at=completed_at,
            queue_length=len(self._queue),
            token_usage_input=usage_total or 0,
            error_message=error_message,
            app_server_pid=_app_server_pid(self._codex),
        )
        event_kind = "turn-attn" if summary.tier == TurnTier.attn else "turn-done"
        payload = {"kind": event_kind, "session": self._name, **summary.model_dump(mode="json")}
        self._event_bus.publish("events", payload)

        if wait_future is not None and not wait_future.done():
            wait_future.set_result(summary.model_dump(mode="json"))

        next_item: PendingSend | None = None
        async with self._state_lock:
            next_item = self._queue.pop()
            self._registry.update(self._name, queue_length=len(self._queue))
            if next_item is None:
                self._running = False
            else:
                self._running = True
                self._registry.update(self._name, status=SessionStatus.running)

        if next_item is not None:
            asyncio.create_task(self._run_turn(next_item.text, next_item.wait_future, next_item.overrides))


class SessionFactory:
    def __init__(
        self,
        cfg: Config,
        registry: RegistryStore,
        event_bus: EventBus,
        *,
        compaction: CompactionMonitor | None = None,
        codex_factory: CodexFactory | None = None,
    ) -> None:
        self._cfg = cfg
        self._registry = registry
        self._event_bus = event_bus
        self._compaction = compaction
        self._codex_factory = codex_factory or self._default_codex_factory

    def _default_codex_factory(self, **kwargs: Any) -> object:
        if AsyncCodex is None or AppServerConfig is None:
            raise RuntimeError(
                "codex-app-server-sdk is not importable in the daemon's Python "
                "environment. The bootstrap script attempted to install it from "
                "the plugin pyproject.toml but did not succeed. "
                "Fix options: (a) run the plugin's bootstrap script explicitly "
                "— `${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap-python-env.sh` — and "
                "check its stderr output; (b) set CODEX_TEAM_SDK_PATH to a local "
                "codex/sdk/python checkout and re-run bootstrap; (c) install "
                "manually with `<venv>/bin/pip install codex-app-server-sdk` or "
                "`pip install -e /path/to/codex/sdk/python`. See "
                "`configure-codex-team` skill's Environment & dependencies "
                "section for the full decision tree."
            )
        return AsyncCodex(**kwargs)

    def _data_dir(self) -> Path:
        return Path(self._cfg.daemon.data_dir)

    def _build_codex(self, cwd: str) -> object:
        kwargs: dict[str, Any] = {}
        if AppServerConfig is not None:
            env = None
            if self._cfg.daemon.codex_home:
                env = {"CODEX_HOME": self._cfg.daemon.codex_home}
            kwargs["config"] = AppServerConfig(
                codex_bin=resolve_codex_bin(self._cfg),
                cwd=cwd,
                env=env,
                launch_args_override=tuple(self._cfg.daemon.launch_args_override) or None,
                config_overrides=tuple(self._cfg.daemon.config_overrides),
            )
        return self._codex_factory(**kwargs)

    async def create(
        self,
        name: str,
        *,
        cwd: str | None = None,
        model: str | None = None,
        model_provider: str | None = None,
        sandbox: str | None = None,
        approval_policy: str | None = None,
        service_tier: str | None = None,
        reasoning_effort: str | None = None,
        personality: str | None = None,
        base_instructions: str | None = None,
        developer_instructions: str | None = None,
        profile: str | None = None,
        ephemeral: bool | None = None,
    ) -> Session:
        try:
            self._registry.get(name)
        except SessionNotFound:
            pass
        else:
            raise SessionExists(name)

        requested_profile = profile or self._cfg.defaults.profile or ""
        selected_profile = self._cfg.profiles.get(requested_profile)
        if requested_profile and selected_profile is None:
            raise InvalidRequest(f"unknown profile: {requested_profile}")
        resolved_cwd = cwd or (selected_profile.cwd if selected_profile else "") or self._cfg.defaults.cwd or str(self._data_dir())
        resolved_model = model or (selected_profile.model if selected_profile else "") or self._cfg.defaults.model
        resolved_model_provider = (
            model_provider
            or (selected_profile.model_provider if selected_profile else "")
            or self._cfg.defaults.model_provider
            or None
        )
        resolved_sandbox = normalize_sandbox_mode(
            sandbox or (selected_profile.sandbox if selected_profile else "") or self._cfg.defaults.sandbox
        )
        resolved_approval = normalize_approval_policy(
            approval_policy
            or (selected_profile.approval_policy if selected_profile else "")
            or self._cfg.defaults.approval_policy
        )
        resolved_service_tier = (
            service_tier
            or (selected_profile.service_tier if selected_profile else "")
            or self._cfg.defaults.service_tier
            or None
        )
        resolved_reasoning_effort = (
            reasoning_effort
            or (selected_profile.reasoning_effort if selected_profile else "")
            or self._cfg.defaults.reasoning_effort
            or None
        )
        resolved_personality = (
            personality
            or (selected_profile.personality if selected_profile else "")
            or self._cfg.defaults.personality
            or None
        )
        resolved_base_instructions = (
            base_instructions
            or (selected_profile.base_instructions if selected_profile else "")
            or self._cfg.defaults.base_instructions
            or None
        )
        resolved_developer_instructions = (
            developer_instructions
            or (selected_profile.developer_instructions if selected_profile else "")
            or self._cfg.defaults.developer_instructions
            or None
        )
        resolved_ephemeral = ephemeral if ephemeral is not None else (selected_profile.ephemeral if selected_profile else False)

        codex = self._build_codex(resolved_cwd)
        thread_config = {"model_reasoning_effort": resolved_reasoning_effort} if resolved_reasoning_effort else None
        thread = await codex.thread_start(
            cwd=resolved_cwd,
            model=resolved_model,
            model_provider=resolved_model_provider,
            sandbox=resolved_sandbox,
            approval_policy=resolved_approval,
            service_tier=resolved_service_tier,
            personality=resolved_personality,
            base_instructions=resolved_base_instructions,
            developer_instructions=resolved_developer_instructions,
            ephemeral=resolved_ephemeral,
            config=thread_config,
            service_name="cc-codex-team",
        )
        entry = RegistryEntry(
            name=name,
            thread_id=thread.id,
            cwd=resolved_cwd,
            model=resolved_model,
            model_provider=resolved_model_provider,
            sandbox=resolved_sandbox,
            approval_policy=resolved_approval,
            service_tier=resolved_service_tier,
            reasoning_effort=resolved_reasoning_effort,
            personality=resolved_personality,
            profile=requested_profile or None,
            created_at=_now_iso(),
            app_server_pid=_app_server_pid(codex),
        )
        self._registry.create(entry)
        return Session(
            name=name,
            cfg=self._cfg,
            data_dir=self._data_dir(),
            registry=self._registry,
            event_bus=self._event_bus,
            compaction=self._compaction,
            codex=codex,
            thread=thread,
        )

    async def resume(self, name: str) -> Session:
        entry = self._registry.get(name)
        codex = self._build_codex(entry.cwd)
        thread = await codex.thread_resume(entry.thread_id, cwd=entry.cwd)
        self._registry.update(name, status=SessionStatus.idle, error_message=None, app_server_pid=_app_server_pid(codex))
        return Session(
            name=name,
            cfg=self._cfg,
            data_dir=self._data_dir(),
            registry=self._registry,
            event_bus=self._event_bus,
            compaction=self._compaction,
            codex=codex,
            thread=thread,
        )
