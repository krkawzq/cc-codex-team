"""Unix-domain-socket daemon server."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Awaitable, Callable

from codex_team.config import Config, load_config
from codex_team.daemon.compaction import CompactionMonitor
from codex_team.daemon.event_bus import EventBus
from codex_team.daemon.health import HealthMonitor
from codex_team.daemon.registry import RegistryStore
from codex_team.daemon.session import Session, SessionFactory
from codex_team.daemon.watchdog import WatchdogTimer
from codex_team.errors import CodexTeamError, InvalidRequest, SessionNotFound, error_to_wire

Handler = Callable[..., Awaitable[dict[str, Any]]]


class DaemonServer:
    def __init__(
        self,
        *,
        cfg: Config,
        socket_path: Path,
        codex_factory=None,
        shutdown_callback=None,
    ) -> None:
        self._cfg = cfg
        self._socket_path = socket_path
        self._shutdown_callback = shutdown_callback
        self._bus = EventBus(
            max_buffer=cfg.monitor.events_max_buffer,
            subscriber_queue_max=cfg.monitor.subscriber_queue_max,
        )
        self._registry = RegistryStore(Path(cfg.daemon.data_dir) / "registry.json")
        self._compaction = CompactionMonitor(cfg=cfg, registry=self._registry, event_bus=self._bus)
        self._sessions: dict[str, Session] = {}
        self._factory = SessionFactory(
            cfg,
            self._registry,
            self._bus,
            compaction=self._compaction,
            codex_factory=codex_factory,
        )
        self._watchdog = WatchdogTimer(cfg=cfg, registry=self._registry, event_bus=self._bus)
        self._health = HealthMonitor(
            cfg=cfg,
            registry=self._registry,
            sessions=self._sessions,
            event_bus=self._bus,
            factory=self._factory,
        )
        self._server: asyncio.AbstractServer | None = None
        self._bg_tasks: list[asyncio.Task[None]] = []
        self._handlers: dict[str, Handler] = {
            "session.create": _h_session_create,
            "session.list": _h_session_list,
            "session.status": _h_session_status,
            "session.close": _h_session_close,
            "session.ack_error": _h_session_ack_error,
            "session.dump": _h_session_dump,
            "session.resume": _h_session_resume,
            "session.restart": _h_session_restart,
            "session.kill": _h_session_kill,
            "session.forget": _h_session_forget,
            "send": _h_send,
            "interrupt": _h_interrupt,
            "compact": _h_compact,
            "history.get": _h_history_get,
            "history.tail_stderr": _h_history_tail_stderr,
            "queue.show": _h_queue_show,
            "queue.clear": _h_queue_clear,
            "queue.drop_oldest": _h_queue_drop_oldest,
            "queue.retry_last": _h_queue_retry_last,
            "health.check": _h_health_check,
            "health.report": _h_health_report,
            "health.repair": _h_health_repair,
            "daemon.status": _h_daemon_status,
            "daemon.stop": _h_daemon_stop,
            "daemon.logs": _h_daemon_logs,
            "daemon.reload_config": _h_daemon_reload_config,
            "monitor.events.subscribe": _h_monitor_events,
            "monitor.watchdog.subscribe": _h_monitor_watchdog,
        }

    @property
    def cfg(self) -> Config:
        return self._cfg

    @property
    def registry(self) -> RegistryStore:
        return self._registry

    @property
    def event_bus(self) -> EventBus:
        return self._bus

    @property
    def factory(self) -> SessionFactory:
        return self._factory

    @property
    def sessions(self) -> dict[str, Session]:
        return self._sessions

    def request_shutdown(self) -> None:
        if self._shutdown_callback is not None:
            self._shutdown_callback()

    def replace_config(self, cfg: Config) -> None:
        cfg.daemon.data_dir = cfg.daemon.data_dir or self._cfg.daemon.data_dir
        cfg.daemon.socket_path = cfg.daemon.socket_path or self._cfg.daemon.socket_path
        self._cfg = cfg
        self._bus._max_buffer = cfg.monitor.events_max_buffer  # noqa: SLF001
        self._bus._subscriber_queue_max = cfg.monitor.subscriber_queue_max  # noqa: SLF001
        self._factory._cfg = cfg  # noqa: SLF001
        self._health._cfg = cfg  # noqa: SLF001
        self._watchdog._cfg = cfg  # noqa: SLF001
        self._compaction._cfg = cfg  # noqa: SLF001
        for session in self._sessions.values():
            session._cfg = cfg  # noqa: SLF001

    async def start(self) -> None:
        self._socket_path.parent.mkdir(parents=True, exist_ok=True)
        if self._socket_path.exists():
            self._socket_path.unlink()
        self._server = await asyncio.start_unix_server(self._handle, path=str(self._socket_path))

        async def watchdog_loop() -> None:
            while True:
                await asyncio.sleep(self._cfg.monitor.watchdog_interval_seconds)
                await self._watchdog.tick_once()

        async def heartbeat_loop() -> None:
            while True:
                await asyncio.sleep(self._cfg.heartbeat.interval_seconds)
                await self._health.tick_once()

        self._bg_tasks.append(asyncio.create_task(watchdog_loop()))
        self._bg_tasks.append(asyncio.create_task(heartbeat_loop()))

    async def stop(self) -> None:
        for task in self._bg_tasks:
            task.cancel()
        self._bg_tasks.clear()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        for session in list(self._sessions.values()):
            await session.shutdown()
        self._sessions.clear()
        if self._socket_path.exists():
            self._socket_path.unlink()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                line = await reader.readline()
                if not line:
                    return
                request_id = "?"
                command = None
                try:
                    message = json.loads(line.decode("utf-8"))
                    request_id = str(message.get("id", "?"))
                    command = message.get("cmd")
                    if not isinstance(command, str):
                        raise InvalidRequest("cmd missing")
                    handler = self._handlers.get(command)
                    if handler is None:
                        raise InvalidRequest(f"unknown cmd: {command}")
                    if command.startswith("monitor."):
                        await handler(message, self, writer)
                        return
                    data = await handler(message, self)
                    response = {"id": request_id, "ok": True, "data": data}
                except CodexTeamError as exc:
                    response = {"id": request_id, "ok": False, "error": error_to_wire(exc)}
                except Exception as exc:  # noqa: BLE001
                    response = {
                        "id": request_id,
                        "ok": False,
                        "error": {"code": "E_INTERNAL", "msg": str(exc), "detail": {}},
                    }
                writer.write((json.dumps(response) + "\n").encode("utf-8"))
                await writer.drain()
                if command == "daemon.stop" and response.get("ok"):
                    self.request_shutdown()
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass


async def _h_session_create(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    params = message.get("params") or {}
    name = params.get("name")
    if not name:
        raise InvalidRequest("name required")
    session = await server.factory.create(
        str(name),
        cwd=params.get("cwd"),
        model=params.get("model"),
        model_provider=params.get("model_provider"),
        sandbox=params.get("sandbox"),
        approval_policy=params.get("approval_policy"),
        service_tier=params.get("service_tier"),
        reasoning_effort=params.get("reasoning_effort"),
        personality=params.get("personality"),
        base_instructions=params.get("base_instructions"),
        developer_instructions=params.get("developer_instructions"),
        profile=params.get("profile"),
        ephemeral=params.get("ephemeral"),
    )
    server.sessions[session.name] = session
    entry = server.registry.get(session.name)
    return {"name": session.name, "thread_id": entry.thread_id}


async def _h_session_list(_message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    return {"sessions": [entry.model_dump(mode="json") for entry in server.registry.list()]}


async def _h_session_status(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = (message.get("params") or {}).get("name")
    return server.registry.get(str(name)).model_dump(mode="json")


async def _h_session_close(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    if name in server.sessions:
        await server.sessions[name].close()
        del server.sessions[name]
    else:
        server.registry.update(name, status="closed", app_server_pid=None)
    return {"name": name, "closed": True}


async def _h_session_ack_error(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    session = server.sessions.get(name)
    if session is not None:
        await session.ack_error()
    else:
        server.registry.update(name, status="idle", error_message=None)
    return {"name": name, "acked": True}


async def _h_session_dump(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    session = server.sessions.get(name)
    if session is not None:
        return session.dump_state()
    entry = server.registry.get(name).model_dump(mode="json")
    base = Path(server.cfg.daemon.data_dir) / "sessions" / name
    stderr_path = base / "app-server.stderr.log"
    stderr_tail = ""
    if stderr_path.exists():
        stderr_tail = "\n".join(stderr_path.read_text("utf-8").splitlines()[-20:])
    return {
        "session": entry,
        "queue": [],
        "transport_alive": False,
        "stderr_tail": stderr_tail,
        "history_path": str(base / "history.md"),
        "turns_path": str(base / "turns.jsonl"),
    }


async def _h_session_resume(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    session = await server.factory.resume(name)
    server.sessions[name] = session
    return {"name": name, "resumed": True}


async def _h_session_restart(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    if name in server.sessions:
        await server.sessions[name].close()
        del server.sessions[name]
    session = await server.factory.resume(name)
    server.sessions[name] = session
    return {"name": name, "restarted": True}


async def _h_session_kill(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    session = server.sessions.get(name)
    if session is None:
        raise SessionNotFound(name)
    await session.kill(reason="killed by operator")
    del server.sessions[name]
    return {"name": name, "killed": True}


async def _h_session_forget(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    if name in server.sessions:
        await server.sessions[name].close()
        del server.sessions[name]
    try:
        server.registry.delete(name)
    except SessionNotFound:
        pass
    return {"name": name, "forgotten": True}


async def _h_send(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    params = message.get("params") or {}
    name = str(params.get("name"))
    text = str(params.get("text") or "")
    wait = bool(params.get("wait"))
    overrides = {
        "cwd": params.get("cwd"),
        "model": params.get("model"),
        "effort": params.get("effort"),
        "personality": params.get("personality"),
        "service_tier": params.get("service_tier"),
        "summary": params.get("summary"),
        "output_schema": params.get("output_schema"),
    }
    overrides = {key: value for key, value in overrides.items() if value not in (None, "", {})}
    session = server.sessions.get(name)
    if session is None:
        raise SessionNotFound(name)
    result = await session.send(text, wait=wait, overrides=overrides or None)
    if isinstance(result, dict):
        return {"name": name, "summary": result}
    return {"name": name, "queued_or_turn_id": result}


async def _h_interrupt(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    session = server.sessions.get(name)
    if session is None:
        raise SessionNotFound(name)
    await session.interrupt()
    return {"name": name, "interrupted": True}


async def _h_compact(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    session = server.sessions.get(name)
    if session is None:
        raise SessionNotFound(name)
    before = server.registry.get(name).token_usage_input
    await session.compact()
    after = server.registry.get(name).token_usage_input
    server.event_bus.publish("events", {"kind": "compact-done", "session": name, "before": before, "after": after})
    return {"name": name, "compacted": True}


async def _h_history_get(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    params = message.get("params") or {}
    name = str(params.get("name"))
    fmt = str(params.get("format", "md"))
    base = Path(server.cfg.daemon.data_dir) / "sessions" / name
    path = base / ("history.md" if fmt == "md" else "turns.jsonl")
    if not path.exists():
        return {"name": name, "content": ""}
    last_n = int(params.get("last_n") or 0)
    since = params.get("since")
    if fmt == "jsonl":
        lines: list[str] = []
        with path.open("r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.rstrip("\n")
                if not line:
                    continue
                if since:
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    completed_at = payload.get("completed_at")
                    if completed_at and completed_at < since:
                        continue
                lines.append(line)
        if last_n:
            lines = lines[-last_n:]
        content = "\n".join(lines)
        if content:
            content += "\n"
    else:
        content = path.read_text("utf-8")
    return {"name": name, "content": content}


async def _h_history_tail_stderr(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    params = message.get("params") or {}
    name = str(params.get("name"))
    lines = int(params.get("lines") or 200)
    path = Path(server.cfg.daemon.data_dir) / "sessions" / name / "app-server.stderr.log"
    if not path.exists():
        return {"name": name, "content": ""}
    content = "\n".join(path.read_text("utf-8").splitlines()[-lines:])
    return {"name": name, "content": content}


async def _h_queue_show(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    session = server.sessions.get(name)
    if session is None:
        raise SessionNotFound(name)
    return {"name": name, "items": session.snapshot_queue_json()}


async def _h_queue_clear(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    session = server.sessions.get(name)
    if session is None:
        raise SessionNotFound(name)
    session.clear_queue()
    return {"name": name, "cleared": True}


async def _h_queue_drop_oldest(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    name = str((message.get("params") or {}).get("name"))
    session = server.sessions.get(name)
    if session is None:
        raise SessionNotFound(name)
    dropped = session.drop_oldest()
    return {"name": name, "dropped": dropped.id if dropped else None}


async def _h_queue_retry_last(message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    params = message.get("params") or {}
    name = str(params.get("name"))
    session = server.sessions.get(name)
    if session is None:
        raise SessionNotFound(name)
    entry = server.registry.get(name)
    prompt = entry.last_prompt_text
    if not prompt:
        raise InvalidRequest(f"session {name} has no last prompt to retry")
    result = await session.send(prompt, wait=bool(params.get("wait")))
    return {"name": name, "retried": True, "result": result}


async def _h_health_check(_message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    await server._health.tick_once()  # noqa: SLF001
    return {"checked": True, "sessions": len(server.registry.list())}


async def _h_health_report(_message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    sessions = []
    for entry in server.registry.list():
        session = server.sessions.get(entry.name)
        sessions.append(
            {
                "name": entry.name,
                "status": entry.status.value,
                "queue_length": entry.queue_length,
                "app_server_pid": entry.app_server_pid,
                "last_turn_id": entry.last_turn_id,
                "last_error": entry.error_message,
                "transport_alive": session.is_transport_alive() if session is not None else False,
            }
        )
    return {"sessions": sessions}


async def _h_health_repair(_message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    for entry in server.registry.list():
        if entry.status.value == "errored":
            try:
                session = await server.factory.resume(entry.name)
            except Exception as exc:  # noqa: BLE001
                server.registry.update(entry.name, error_message=str(exc))
            else:
                server.sessions[entry.name] = session
    return {"repaired": True}


async def _h_daemon_status(_message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    return {
        "sessions": len(server.registry.list()),
        "events_last_seq": server.event_bus.last_seq("events"),
        "watchdog_last_seq": server.event_bus.last_seq("watchdog"),
    }


async def _h_daemon_stop(_message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    return {"stopping": True}


async def _h_daemon_logs(_message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    path = Path(server.cfg.daemon.data_dir) / "daemon.log"
    if not path.exists():
        return {"content": ""}
    return {"content": path.read_text("utf-8")}


async def _h_daemon_reload_config(_message: dict[str, Any], server: DaemonServer) -> dict[str, Any]:
    reloaded = load_config()
    reloaded.daemon.data_dir = server.cfg.daemon.data_dir
    reloaded.daemon.socket_path = server.cfg.daemon.socket_path or reloaded.daemon.socket_path
    server.replace_config(reloaded)
    return {"reloaded": True}


async def _subscribe_stream(
    stream: str, message: dict[str, Any], server: DaemonServer, writer: asyncio.StreamWriter
) -> None:
    params = message.get("params") or {}
    since_seq = int(params.get("since_seq") or 0)
    queue = await server.event_bus.subscribe(stream, since_seq=since_seq)
    try:
        while True:
            event = await queue.get()
            wire = {
                "kind": "event",
                "stream": stream,
                "seq": event.seq,
                "payload": event.payload,
            }
            writer.write((json.dumps(wire) + "\n").encode("utf-8"))
            await writer.drain()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        await server.event_bus.unsubscribe(stream, queue)


async def _h_monitor_events(message: dict[str, Any], server: DaemonServer, writer: asyncio.StreamWriter) -> dict[str, Any]:
    await _subscribe_stream("events", message, server, writer)
    return {}


async def _h_monitor_watchdog(message: dict[str, Any], server: DaemonServer, writer: asyncio.StreamWriter) -> dict[str, Any]:
    await _subscribe_stream("watchdog", message, server, writer)
    return {}
