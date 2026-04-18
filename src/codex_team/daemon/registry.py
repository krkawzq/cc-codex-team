"""Persistent session registry."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from codex_team.errors import SessionExists, SessionNotFound
from codex_team.schemas.registry import RegistryEntry


class RegistryStore:
    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.Lock()
        self._entries: dict[str, RegistryEntry] = {}
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        payload = json.loads(self._path.read_text("utf-8") or "{}")
        for name, data in payload.get("sessions", {}).items():
            self._entries[name] = RegistryEntry.model_validate(data)

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"sessions": {name: entry.model_dump(mode="json") for name, entry in self._entries.items()}}
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, separators=(",", ":")), "utf-8")
        tmp.replace(self._path)

    def create(self, entry: RegistryEntry) -> None:
        with self._lock:
            if entry.name in self._entries:
                raise SessionExists(f"session {entry.name!r} already exists")
            self._entries[entry.name] = entry
            self._save()

    def get(self, name: str) -> RegistryEntry:
        with self._lock:
            if name not in self._entries:
                raise SessionNotFound(f"session {name!r} not found")
            return self._entries[name].model_copy()

    def list(self) -> list[RegistryEntry]:
        with self._lock:
            return [entry.model_copy() for entry in self._entries.values()]

    def update(self, name: str, **fields) -> RegistryEntry:
        with self._lock:
            if name not in self._entries:
                raise SessionNotFound(f"session {name!r} not found")
            current = self._entries[name].model_dump()
            current.update(fields)
            updated = RegistryEntry.model_validate(current)
            self._entries[name] = updated
            self._save()
            return updated.model_copy()

    def delete(self, name: str) -> None:
        with self._lock:
            if name not in self._entries:
                raise SessionNotFound(f"session {name!r} not found")
            del self._entries[name]
            self._save()
