from pathlib import Path

import pytest

from codex_team.daemon.registry import RegistryStore
from codex_team.errors import SessionExists, SessionNotFound
from codex_team.schemas.registry import RegistryEntry, SessionStatus


def _entry(name="A"):
    return RegistryEntry(name=name, thread_id=f"thr_{name}", cwd="/t", model="gpt-5.4", sandbox="danger_full_access")


def test_registry_create_and_get(tmp_path: Path):
    store = RegistryStore(tmp_path / "registry.json")
    store.create(_entry("A"))
    assert store.get("A").thread_id == "thr_A"


def test_registry_create_duplicate_raises(tmp_path: Path):
    store = RegistryStore(tmp_path / "registry.json")
    store.create(_entry("A"))
    with pytest.raises(SessionExists):
        store.create(_entry("A"))


def test_registry_get_missing_raises(tmp_path: Path):
    store = RegistryStore(tmp_path / "registry.json")
    with pytest.raises(SessionNotFound):
        store.get("A")


def test_registry_update_persists(tmp_path: Path):
    path = tmp_path / "registry.json"
    store = RegistryStore(path)
    store.create(_entry("A"))
    store.update("A", status=SessionStatus.running, queue_length=3)
    reloaded = RegistryStore(path)
    got = reloaded.get("A")
    assert got.status == SessionStatus.running
    assert got.queue_length == 3


def test_registry_list(tmp_path: Path):
    store = RegistryStore(tmp_path / "registry.json")
    store.create(_entry("A"))
    store.create(_entry("B"))
    assert sorted(entry.name for entry in store.list()) == ["A", "B"]


def test_registry_delete(tmp_path: Path):
    store = RegistryStore(tmp_path / "registry.json")
    store.create(_entry("A"))
    store.delete("A")
    with pytest.raises(SessionNotFound):
        store.get("A")
