"""Тесты `lib/env` — резолв env_path, idempotent load, require/get, set_persistent.

Тестируем underscore-хелперы `_format_value` и флаг `_loaded` напрямую — отсюда
file-level отключение reportPrivateUsage.
"""
# pyright: reportPrivateUsage=false

import os
from pathlib import Path

import pytest

from mpu.lib import env

# --- env_path ----------------------------------------------------------------


def test_env_path_uses_xdg(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert env.env_path() == tmp_path / "mpu" / ".env"


def test_env_path_falls_back_to_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.setattr(env.Path, "home", lambda: tmp_path)
    assert env.env_path() == tmp_path / ".config" / "mpu" / ".env"


# --- load --------------------------------------------------------------------


def test_load_reads_env_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    cfg = tmp_path / "mpu"
    cfg.mkdir(parents=True)
    (cfg / ".env").write_text("MPU_TEST_VAR='hello'\n", encoding="utf-8")
    # delenv → monkeypatch восстановит «отсутствие» на teardown, убрав запись load_dotenv.
    monkeypatch.delenv("MPU_TEST_VAR", raising=False)
    monkeypatch.setattr(env, "_loaded", False)
    env.load()
    assert os.environ["MPU_TEST_VAR"] == "hello"


def test_load_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "_loaded", True)
    calls: list[int] = []

    def fake_load_dotenv(*args: object, **kwargs: object) -> bool:
        calls.append(1)
        return True

    monkeypatch.setattr(env, "load_dotenv", fake_load_dotenv)
    env.load()
    assert calls == []


def test_load_no_file_sets_loaded(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))  # mpu/.env не создан
    monkeypatch.setattr(env, "_loaded", False)
    calls: list[int] = []

    def fake_load_dotenv(*args: object, **kwargs: object) -> bool:
        calls.append(1)
        return True

    monkeypatch.setattr(env, "load_dotenv", fake_load_dotenv)
    env.load()
    assert calls == []
    assert env._loaded is True


# --- require -----------------------------------------------------------------


def test_require_returns_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "_loaded", True)  # обойти чтение реального .env
    monkeypatch.setenv("MPU_REQ", "val")
    assert env.require("MPU_REQ") == "val"


def test_require_missing_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "_loaded", True)
    monkeypatch.delenv("MPU_REQ_MISSING", raising=False)
    with pytest.raises(RuntimeError, match="MPU_REQ_MISSING is not set"):
        env.require("MPU_REQ_MISSING")


def test_require_empty_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "_loaded", True)
    monkeypatch.setenv("MPU_REQ_EMPTY", "")
    with pytest.raises(RuntimeError, match="MPU_REQ_EMPTY is not set"):
        env.require("MPU_REQ_EMPTY")


# --- get ---------------------------------------------------------------------


def test_get_returns_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "_loaded", True)
    monkeypatch.setenv("MPU_GET", "g")
    assert env.get("MPU_GET") == "g"


def test_get_default_and_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "_loaded", True)
    monkeypatch.delenv("MPU_GET_MISSING", raising=False)
    assert env.get("MPU_GET_MISSING", "def") == "def"
    assert env.get("MPU_GET_MISSING") is None


# --- _format_value -----------------------------------------------------------


def test_format_value_simple_unquoted() -> None:
    assert env._format_value("simpleURL123") == "simpleURL123"


def test_format_value_space_quoted() -> None:
    assert env._format_value("has space") == "'has space'"


def test_format_value_hash_quoted() -> None:
    assert env._format_value("a#b") == "'a#b'"


def test_format_value_empty_quoted() -> None:
    assert env._format_value("") == "''"


def test_format_value_newline_raises() -> None:
    with pytest.raises(ValueError, match="newlines"):
        env._format_value("a\nb")


def test_format_value_single_quote_raises() -> None:
    with pytest.raises(ValueError, match="single quote"):
        env._format_value("a'b")


# --- set_persistent ----------------------------------------------------------


def test_set_persistent_creates_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.delenv("MPU_NEW", raising=False)
    env.set_persistent("MPU_NEW", "value1")
    path = tmp_path / "mpu" / ".env"
    assert path.read_text(encoding="utf-8") == "MPU_NEW=value1\n"
    assert os.environ["MPU_NEW"] == "value1"


def test_set_persistent_updates_existing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.delenv("MPU_X", raising=False)
    cfg = tmp_path / "mpu"
    cfg.mkdir(parents=True)
    (cfg / ".env").write_text("# header\nexport MPU_X=old\nOTHER=keep\n", encoding="utf-8")
    env.set_persistent("MPU_X", "new")
    content = (cfg / ".env").read_text(encoding="utf-8")
    assert "MPU_X=new" in content
    assert "old" not in content
    assert "# header" in content
    assert "OTHER=keep" in content


def test_set_persistent_appends_when_absent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.delenv("MPU_Y", raising=False)
    cfg = tmp_path / "mpu"
    cfg.mkdir(parents=True)
    (cfg / ".env").write_text("EXISTING=1\n", encoding="utf-8")
    env.set_persistent("MPU_Y", "2")
    assert (cfg / ".env").read_text(encoding="utf-8") == "EXISTING=1\nMPU_Y=2\n"


def test_set_persistent_quotes_complex_value(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.delenv("MPU_Q", raising=False)
    env.set_persistent("MPU_Q", "a b")
    path = tmp_path / "mpu" / ".env"
    assert path.read_text(encoding="utf-8") == "MPU_Q='a b'\n"
    # os.environ получает СЫРОЕ значение, не закавыченное.
    assert os.environ["MPU_Q"] == "a b"


def test_set_persistent_sets_permissions(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.delenv("MPU_PERM", raising=False)
    env.set_persistent("MPU_PERM", "v")
    path = tmp_path / "mpu" / ".env"
    assert path.stat().st_mode & 0o777 == 0o600
