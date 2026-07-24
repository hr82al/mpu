"""Тесты лога вызовов (`mpu.lib.log`): формат записи, маскировка, ротация, права, sink."""

import multiprocessing
import os
import re
import stat
from datetime import datetime
from pathlib import Path

import pytest

from mpu.lib import capture, log


def _streams(out: bytes = b"", err: bytes = b"", *, dropped: int = 0) -> capture.CapturedStreams:
    return capture.CapturedStreams(out, err, dropped, 0, active=True)


def _record(**overrides: object) -> str:
    moment = datetime.fromisoformat("2026-07-21T16:39:12.345+03:00")
    kwargs: dict[str, object] = {
        "run_id": "20260721-163912.345-777",
        "moment": moment,
        "argv": ["sql-ro", "1973", "select 1"],
        "exit_code": 0,
        "duration_seconds": 1.2345,
        "notes": [],
        "streams": _streams(),
    }
    kwargs.update(overrides)
    return log.build_record(**kwargs).decode()  # pyright: ignore[reportArgumentType]


# ── формат записи ───────────────────────────────────────────────────────────────


def test_header_carries_date_time_offset_and_run_id() -> None:
    text = _record()
    assert text.startswith("### 2026-07-21 16:39:12.345 +03:00 run=20260721-163912.345-777 pid=")
    assert f"cwd={Path.cwd()}" in text.splitlines()[0]


def test_command_line_is_normalised_to_literal_mpu() -> None:
    """`$ mpu …` без argv[0]: иначе grep по `^$ mpu <команда>` ломался бы на пути к бинарю."""
    assert _record().splitlines()[1] == "$ mpu sql-ro 1973 'select 1'"


def test_end_marker_has_exit_and_duration() -> None:
    text = _record(exit_code=2, duration_seconds=0.5)
    assert "--- end run=20260721-163912.345-777 exit=2 dur=0.500s ---" in text
    assert text.endswith("---\n\n")  # запись отделена пустой строкой


def test_empty_sections_are_omitted() -> None:
    """Нет данных — нет и маркера: пустая секция была бы синтаксическим шумом."""
    text = _record()
    assert "--- out" not in text
    assert "--- err" not in text
    assert "--- note" not in text


def test_output_written_verbatim_with_single_trailing_newline() -> None:
    text = _record(streams=_streams(out=b"\x1b[1;32m<b>plain\ttext"))
    assert "--- out run=20260721-163912.345-777 ---\n\x1b[1;32m<b>plain\ttext\n--- end" in text


def test_notes_and_truncation_markers() -> None:
    text = _record(notes=["sheet_api get: retry 2/3"], streams=_streams(out=b"x", dropped=4325))
    assert "--- note run=20260721-163912.345-777 ---\nsheet_api get: retry 2/3\n" in text
    assert "--- truncated run=20260721-163912.345-777 stream=out dropped=4325 ---" in text


def test_broken_utf8_tail_from_truncation_is_dropped() -> None:
    """Обрезка режет байты — незавершённый символ в лог не попадает."""
    text = _record(streams=_streams(out="привет".encode()[:-1], dropped=1))
    assert "приве" in text


# ── маскировка секретов ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        (
            ["api", "wb-token-add", "--password", "hunter2"],
            "$ mpu api wb-token-add --password REDACTED",
        ),
        (["api", "x", "--api-key=abc"], "$ mpu api x --api-key=REDACTED"),
        (["api", "x", "--session", "s3cr3t"], "$ mpu api x --session REDACTED"),
        (["sql-ro", "1973", "select 1"], "$ mpu sql-ro 1973 'select 1'"),
    ],
)
def test_secret_options_are_masked(argv: list[str], expected: str) -> None:
    assert log.command_line(argv) == expected


def test_body_json_keys_are_masked_but_file_reference_is_not() -> None:
    line = log.command_line(["api", "x", "--body", '{"token": "t", "id": 1}'])
    assert '"token": "REDACTED"' in line
    assert '"id": 1' in line
    assert log.command_line(["api", "x", "--body", "@secrets.json"]).endswith("@secrets.json")


def test_non_json_body_is_left_as_is() -> None:
    assert log.command_line(["api", "x", "--body", "not-json"]).endswith("not-json")


# ── sink: запись, права, ротация ────────────────────────────────────────────────


def _config(path: Path, *, max_bytes: int = 0, keep: int = 5) -> log.LogConfig:
    return log.LogConfig(path=path, max_output_bytes=0, max_bytes=max_bytes, keep=keep)


def test_emit_creates_missing_directory(tmp_path: Path) -> None:
    """Свежая машина: каталога `~/.config/mpu` может не быть — логирование не должно умирать."""
    target = tmp_path / "нет" / "такого" / "mpu.log"
    log.emit(b"record\n", _config(target))
    assert target.read_bytes() == b"record\n"


def test_log_and_lock_are_owner_only(tmp_path: Path) -> None:
    """Лог содержит вывод боевых команд — тот же класс секретности, что `.env`."""
    target = tmp_path / "mpu.log"
    log.emit(b"record\n", _config(target))
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert stat.S_IMODE((tmp_path / log.LOCK_NAME).stat().st_mode) == 0o600


def test_existing_world_readable_log_is_hardened(tmp_path: Path) -> None:
    target = tmp_path / "mpu.log"
    target.write_bytes(b"old\n")
    target.chmod(0o644)
    log.emit(b"new\n", _config(target))
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_rotation_shifts_archives_and_drops_the_oldest(tmp_path: Path) -> None:
    target = tmp_path / "mpu.log"
    config = _config(target, max_bytes=20, keep=2)
    log.emit(b"a" * 15 + b"\n", config)
    log.emit(b"b" * 15 + b"\n", config)  # переполнение → .1
    log.emit(b"c" * 15 + b"\n", config)  # .1 → .2, текущий → .1

    assert target.read_bytes().startswith(b"c")
    assert Path(f"{target}.1").read_bytes().startswith(b"b")
    assert Path(f"{target}.2").read_bytes().startswith(b"a")
    assert not Path(f"{target}.3").exists()


def test_keep_zero_rotates_without_archives(tmp_path: Path) -> None:
    target = tmp_path / "mpu.log"
    config = _config(target, max_bytes=20, keep=0)
    log.emit(b"a" * 15 + b"\n", config)
    log.emit(b"b" * 15 + b"\n", config)
    assert target.read_bytes().startswith(b"b")
    assert not Path(f"{target}.1").exists()


def test_max_bytes_zero_never_rotates(tmp_path: Path) -> None:
    target = tmp_path / "mpu.log"
    config = _config(target, max_bytes=0)
    log.emit(b"a" * 100 + b"\n", config)
    log.emit(b"b" * 100 + b"\n", config)
    assert not Path(f"{target}.1").exists()
    assert len(target.read_bytes()) == 202


def test_record_larger_than_limit_is_still_written(tmp_path: Path) -> None:
    """Пустой лог не ротируется: иначе гигантская запись не попала бы никуда."""
    target = tmp_path / "mpu.log"
    log.emit(b"x" * 1000 + b"\n", _config(target, max_bytes=10))
    assert len(target.read_bytes()) == 1001


def test_emit_survives_unwritable_target(tmp_path: Path) -> None:
    """Лог не имеет права уронить команду: недоступный путь — просто no-op."""
    unwritable = tmp_path / "ro"
    unwritable.mkdir()
    unwritable.chmod(0o500)
    try:
        log.emit(b"record\n", _config(unwritable / "mpu.log"))
    finally:
        unwritable.chmod(0o700)


# ── конфигурация из .env ────────────────────────────────────────────────────────


def test_broken_int_env_falls_back_to_default_and_notes_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MPU_LOG_KEEP", "five")
    monkeypatch.setenv("MPU_LOG_MAX_BYTES", "-1")
    config = log.load_config()
    assert config.keep == log.DEFAULT_KEEP
    assert config.max_bytes == log.DEFAULT_MAX_BYTES
    text = _record(notes=log.pending_notes())
    assert "MPU_LOG_KEEP='five' is not int" in text
    assert "MPU_LOG_MAX_BYTES='-1' is negative" in text


@pytest.mark.parametrize("value", ["0", "off", "false", "no", "OFF"])
def test_kill_switch_disables_logging(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("MPU_LOG_ENABLED", value)
    assert log.is_enabled() is False


def test_logging_enabled_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MPU_LOG_ENABLED", "1")
    assert log.is_enabled() is True


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        (["sql-ro", "1"], True),
        (["log", "--tail", "5"], False),
        (["confirm"], False),
        (["search", "user@example.com"], False),
        (["api", "get-token"], False),
        (["api", "get-clients"], True),
        ([], True),
    ],
)
def test_no_capture_commands(argv: list[str], expected: bool) -> None:
    assert log.should_capture(argv) is expected


# ── параллельная запись ─────────────────────────────────────────────────────────


def _hammer(args: tuple[str, int]) -> None:
    path, worker = args
    config = log.LogConfig(path=Path(path), max_output_bytes=0, max_bytes=0, keep=5)
    payload = (f"{worker:02d}" * 400).encode()
    for _ in range(200):
        log.emit(b"<<" + payload + b">>\n", config)


def test_concurrent_writers_never_interleave(tmp_path: Path) -> None:
    """8 процессов × 200 записей: ни одной порванной или перемешанной строки."""
    target = tmp_path / "mpu.log"
    with multiprocessing.get_context("spawn").Pool(8) as pool:
        pool.map(_hammer, [(str(target), worker) for worker in range(8)])

    lines = target.read_bytes().splitlines()
    assert len(lines) == 8 * 200
    pattern = re.compile(rb"\A<<(\d{2})+>>\Z")
    assert all(pattern.match(line) for line in lines)
    assert all(len(line) == 804 for line in lines)  # 800 + << >>


def test_write_proceeds_when_rotation_lock_is_busy(tmp_path: Path) -> None:
    """Лок занят соседним процессом → пишем без ротации, но пишем: лог не может ждать."""
    import fcntl

    target = tmp_path / "mpu.log"
    target.write_bytes(b"x" * 100)
    holder = os.open(str(tmp_path / log.LOCK_NAME), os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(holder, fcntl.LOCK_EX)
    try:
        log.emit(b"record\n", _config(target, max_bytes=10))
    finally:
        os.close(holder)

    assert target.read_bytes().endswith(b"record\n")
    assert not Path(f"{target}.1").exists()  # ротацию пропустили, запись сохранили
