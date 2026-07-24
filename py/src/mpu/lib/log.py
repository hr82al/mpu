"""Лог вызовов `mpu`: одна атомарная запись на вызов в `~/.config/mpu/mpu.log`.

Запись содержит дату и время, командную строку, вывод, ошибки и код возврата; команда и
вывод пишутся verbatim, без отступов и без чистки ANSI. Разметка — маркеры с `run=`,
чтобы блок вызова однозначно склеивался `grep -A` даже если похожий текст встретится в
самом выводе (см. `mpu log --help`).

Транспорт — файл, без демона: `write(2)` в `O_APPEND` на локальной ФС не перемешивается с
чужими записями (ядро держит `i_rwsem`), тогда как сокет/пайп рвёт запись на `PIPE_BUF`.
`flock` берётся только ради ротации: `LOCK_NB` с дедлайном, не взяли — пишем без ротации.
Логгер fail-open: он не имеет права ни уронить команду, ни подменить её код возврата.

Ограничение: на NFS/CIFS ни `O_APPEND`, ни `flock` гарантий не дают — рассчитано на
локальную ФС (`~` на этой машине — btrfs).

Конфигурация — только `~/.config/mpu/.env` (без SQLite: логгер обязан пережить сломанную
`mpu.db` и залогировать сам `mpu init`), см. `LogConfig` и `mpu log --help`. Побочный
эффект: `.env` теперь читается на старте ЛЮБОЙ команды, а не лениво при первом обращении.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import shlex
import stat
import sys
import time
import traceback
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import cast

from mpu.lib import capture, env

__all__ = [
    "LogConfig",
    "invocation_log",
    "load_config",
    "log_file_path",
    "note",
    "pending_notes",
]

DEFAULT_LOG_FILE = Path.home() / ".config" / "mpu" / "mpu.log"
LOCK_NAME = "mpu.lock"  # сосед лога и НЕ `mpu.log.lock`: имя не должно попасть под ротацию

DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_BYTES = 50 * 1024 * 1024
DEFAULT_KEEP = 5

_LOCK_DEADLINE_SECONDS = 0.5
_LOCK_RETRY_SECONDS = 0.005
_FILE_MODE = 0o600
_OFF_VALUES = frozenset({"0", "off", "false", "no"})

# Команды, у которых вывод в лог НЕ пишется и fd не подменяются:
#   log/confirm — механика (`log` удвоил бы лог собой; `confirm` печатает промпт мимо
#   перехвата, прямо в /dev/tty, и дублировал бы payload пайпа);
#   search/api get-token — печатают живые токены.
_NO_CAPTURE_COMMANDS = frozenset({"log", "confirm", "search"})
_NO_CAPTURE_PAIRS = frozenset({("api", "get-token")})

_SECRET_WORD_RE = re.compile(r"password|token|secret|api[-_]?key|session", re.IGNORECASE)
_SECRET_OPT_RE = re.compile(
    r"\A--?[\w-]*(?:password|token|secret|api[-_]?key|session)[\w-]*\Z", re.IGNORECASE
)
_BODY_OPTS = frozenset({"-b", "--body"})
# Токен маскировки без шелл-метасимволов: shlex.join не берёт его в кавычки,
# и grep по нему не требует экранирования (в отличие от `***`).
_MASK = "REDACTED"

_notes: list[str] = []


def pending_notes() -> list[str]:
    """Заметки, накопленные в текущем вызове (копия) — для записи и для тестов."""
    return list(_notes)


def note(message: str) -> None:
    """Диагностическая заметка библиотеки → секция `--- note ---` записи текущего вызова.

    Замена прежним `logger.warning/info`: в терминале не шумит (как и раньше), но видна
    в логе рядом с самим вызовом. Вне обёртки `invocation_log()` (тесты, импорт как
    библиотеки) заметки просто копятся в памяти и никуда не уходят.
    """
    _notes.append(message)


def log_file_path() -> Path:
    """Путь к логу; `MPU_LOG_FILE` побеждает дефолт `~/.config/mpu/mpu.log`."""
    override = env.get("MPU_LOG_FILE")
    return Path(override).expanduser() if override else DEFAULT_LOG_FILE


def is_enabled() -> bool:
    """Kill-switch `MPU_LOG_ENABLED=0|off|false|no` — логирование выключено целиком."""
    raw = env.get("MPU_LOG_ENABLED")
    return raw is None or raw.strip().lower() not in _OFF_VALUES


@dataclass(frozen=True)
class LogConfig:
    """Снимок конфигурации на один вызов (читается один раз, до перехвата)."""

    path: Path
    max_output_bytes: int
    max_bytes: int
    keep: int

    @property
    def lock_path(self) -> Path:
        return self.path.parent / LOCK_NAME


def load_config() -> LogConfig:
    """Собрать конфигурацию из `.env`; кривые значения → дефолт + `note`."""
    return LogConfig(
        path=log_file_path(),
        max_output_bytes=_int_env("MPU_LOG_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES),
        max_bytes=_int_env("MPU_LOG_MAX_BYTES", DEFAULT_MAX_BYTES),
        keep=_int_env("MPU_LOG_KEEP", DEFAULT_KEEP),
    )


def _int_env(name: str, default: int) -> int:
    """Целое из env: пусто → дефолт, мусор/отрицательное → дефолт + заметка в лог."""
    raw = env.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        note(f"log: {name}={raw!r} is not int, using default {default}")
        return default
    if value < 0:
        note(f"log: {name}={raw!r} is negative, using default {default}")
        return default
    return value


# ── строка команды ──────────────────────────────────────────────────────────────


def command_line(argv: Sequence[str]) -> str:
    """`$ mpu …` — argv без argv[0] с литеральным `mpu` впереди.

    Настоящий argv[0] у установленного бинаря — `/home/.../bin/mpu`, а у `python -m mpu`
    — путь к `__main__.py`; и то и другое сломало бы grep по `^$ mpu <команда>`.
    """
    return "$ " + shlex.join(["mpu", *mask_argv(argv)])


def mask_argv(argv: Sequence[str]) -> list[str]:
    """Заменить значения секретных опций на `REDACTED` (в т.ч. ключи внутри `--body` JSON)."""
    masked: list[str] = []
    pending: str | None = None
    for arg in argv:
        if pending == "secret":
            masked.append(_MASK)
            pending = None
            continue
        if pending == "body":
            masked.append(_mask_body(arg))
            pending = None
            continue
        name, sep, value = arg.partition("=")
        if sep and arg.startswith("-"):
            if _SECRET_OPT_RE.match(name):
                masked.append(f"{name}={_MASK}")
                continue
            if name in _BODY_OPTS:
                masked.append(f"{name}={_mask_body(value)}")
                continue
        elif _SECRET_OPT_RE.match(arg):
            masked.append(arg)
            pending = "secret"
            continue
        elif arg in _BODY_OPTS:
            masked.append(arg)
            pending = "body"
            continue
        masked.append(arg)
    return masked


def _mask_body(value: str) -> str:
    """JSON-литерал `--body`: маскируем значения секретных ключей. `@file` не читаем."""
    if value.startswith("@"):
        return value
    try:
        parsed = cast(object, json.loads(value))
    except ValueError:
        return value
    return json.dumps(_mask_json(parsed), ensure_ascii=False)


def _mask_json(value: object) -> object:
    if isinstance(value, dict):
        # json.loads возвращает Any; ключи JSON-объекта всегда строки — сужаем явно.
        items = cast(dict[str, object], value)
        return {
            key: (_MASK if _SECRET_WORD_RE.search(key) else _mask_json(item))
            for key, item in items.items()
        }
    if isinstance(value, list):
        return [_mask_json(item) for item in cast(list[object], value)]
    return value


# ── формат записи ───────────────────────────────────────────────────────────────


def _format_timestamp(moment: datetime) -> str:
    """`2026-07-21 16:39:12.345 +03:00` — дата, время с миллисекундами и смещение."""
    offset = moment.strftime("%z")
    millis = moment.microsecond // 1000
    return f"{moment:%Y-%m-%d %H:%M:%S}.{millis:03d} {offset[:3]}:{offset[3:]}"


def _format_run_id(moment: datetime) -> str:
    """`20260721-163912.345-12345` — метка времени с миллисекундами + pid."""
    return f"{moment:%Y%m%d-%H%M%S}.{moment.microsecond // 1000:03d}-{os.getpid()}"


def _trim_to_utf8_boundary(payload: bytes) -> bytes:
    """Отрезать хвостовую незавершённую UTF-8 последовательность (следствие обрезки)."""
    for cut in range(min(3, len(payload)) + 1):
        candidate = payload[: len(payload) - cut] if cut else payload
        try:
            candidate.decode("utf-8")
        except UnicodeDecodeError:
            continue
        return candidate
    return payload


def _section(name: str, run_id: str, payload: bytes) -> bytes:
    """Секция с verbatim-телом; пустую не печатаем (нет данных — нет и маркера)."""
    if not payload:
        return b""
    body = payload if payload.endswith(b"\n") else payload + b"\n"
    return f"--- {name} run={run_id} ---\n".encode() + body


def _truncated_marker(run_id: str, stream: str, dropped: int) -> bytes:
    if dropped <= 0:
        return b""
    return f"--- truncated run={run_id} stream={stream} dropped={dropped} ---\n".encode()


def build_record(
    *,
    run_id: str,
    moment: datetime,
    argv: Sequence[str],
    exit_code: int,
    duration_seconds: float,
    notes: Sequence[str],
    streams: capture.CapturedStreams,
) -> bytes:
    """Собрать полную запись вызова (заканчивается пустой строкой-разделителем)."""
    header = (
        f"### {_format_timestamp(moment)} run={run_id} "
        f"pid={os.getpid()} cwd={_safe_cwd()}\n{command_line(argv)}\n"
    )
    out = _trim_to_utf8_boundary(streams.out)
    err = _trim_to_utf8_boundary(streams.err)
    parts = [
        header.encode(),
        _section("note", run_id, "\n".join(notes).encode() if notes else b""),
        _section("out", run_id, out),
        _truncated_marker(run_id, "out", streams.out_dropped),
        _section("err", run_id, err),
        _truncated_marker(run_id, "err", streams.err_dropped),
        f"--- end run={run_id} exit={exit_code} dur={duration_seconds:.3f}s ---\n\n".encode(),
    ]
    return b"".join(parts)


def _safe_cwd() -> str:
    try:
        return str(Path.cwd())
    except OSError:
        return "?"  # каталог удалён из-под процесса — не повод терять запись


# ── sink: flock + ротация + один append ─────────────────────────────────────────


def emit(record: bytes, config: LogConfig) -> None:
    """Дописать запись в лог. Все ошибки гасятся: лог не может уронить команду."""
    try:
        config.path.parent.mkdir(parents=True, exist_ok=True)
        lock_fd = os.open(str(config.lock_path), os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, _FILE_MODE)
    except OSError:
        return
    try:
        if _acquire_lock(lock_fd):
            _rotate_if_needed(config, len(record))
        fd = os.open(
            str(config.path),
            os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_CLOEXEC,
            _FILE_MODE,
        )
        try:
            _harden_mode(fd)
            capture.write_all(fd, record)
        finally:
            os.close(fd)
    except OSError:
        pass
    finally:
        os.close(lock_fd)  # закрытие снимает flock, в том числе при падении


def _acquire_lock(fd: int) -> bool:
    """`LOCK_EX|LOCK_NB` с дедлайном: не взяли — не ротируем, но пишем. Не виснем никогда."""
    deadline = time.monotonic() + _LOCK_DEADLINE_SECONDS
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(_LOCK_RETRY_SECONDS)
        else:
            return True


def _rotate_if_needed(config: LogConfig, record_length: int) -> None:
    """Ротация — предусловие записи, а не её часть: её сбой не отменяет сам append."""
    if config.max_bytes <= 0:
        return
    try:
        size = config.path.stat().st_size
    except OSError:
        return  # файла ещё нет либо stat недоступен — ротировать нечего
    if size <= 0 or size + record_length <= config.max_bytes:
        return
    try:
        if config.keep <= 0:
            config.path.unlink(missing_ok=True)
            return
        for index in range(config.keep, 1, -1):
            source = Path(f"{config.path}.{index - 1}")
            if source.exists():
                source.replace(f"{config.path}.{index}")
        config.path.replace(f"{config.path}.1")
    except OSError:
        pass


def _harden_mode(fd: int) -> None:
    """Лог содержит вывод боевых команд — держим 0600, как `.env` и кэш токена."""
    with contextlib.suppress(OSError):
        info = os.fstat(fd)
        if stat.S_ISREG(info.st_mode) and info.st_mode & 0o077:
            os.fchmod(fd, _FILE_MODE)


# ── обёртка вызова ──────────────────────────────────────────────────────────────


def should_capture(argv: Sequence[str]) -> bool:
    """Перехватывать ли вывод этой команды (см. `_NO_CAPTURE_*`)."""
    words = tuple(word for word in argv if not word.startswith("-"))
    if not words:
        return True
    return words[0] not in _NO_CAPTURE_COMMANDS and words[:2] not in _NO_CAPTURE_PAIRS


def _exit_code(error: SystemExit) -> int:
    """`SystemExit.code`: None → 0, int → как есть, строка → 1 (сообщение уйдёт в stderr)."""
    if error.code is None:
        return 0
    if isinstance(error.code, int):
        return error.code
    return 1


@contextmanager
def invocation_log() -> Generator[None]:
    """Обернуть один вызов `mpu`: перехват вывода + запись в лог по завершении.

    Пропускает работу при выключенном `MPU_LOG_ENABLED` и в режиме shell-completion
    (`_MPU_COMPLETE`, иначе каждый TAB писал бы запись).
    """
    if not is_enabled() or os.environ.get("_MPU_COMPLETE"):
        yield
        return

    _notes.clear()
    config = load_config()
    argv = list(sys.argv[1:])
    moment = datetime.now().astimezone()
    run_id = _format_run_id(moment)
    started = time.monotonic()
    capturing = (
        capture.Capture(config.max_output_bytes)
        if should_capture(argv)
        else contextlib.nullcontext()
    )
    exit_code = 0
    failure = ""

    try:
        with capturing:
            try:
                yield
            except SystemExit as error:
                exit_code = _exit_code(error)
                failure = f"{error.code}\n" if isinstance(error.code, str) else ""
                raise
            except BaseException:
                # Traceback печатает интерпретатор уже после восстановления fd —
                # в перехват он не попадёт, поэтому форматируем его сами.
                exit_code = 1
                failure = traceback.format_exc()
                raise
    finally:
        # Ничто отсюда не должно улететь наружу: исключение из finally заменило бы
        # живой SystemExit и подменило команде код возврата.
        with contextlib.suppress(Exception):
            streams = (
                capturing.result
                if isinstance(capturing, capture.Capture)
                else capture.CapturedStreams(b"", b"", 0, 0, active=False)
            )
            if failure:
                streams = capture.CapturedStreams(
                    streams.out,
                    streams.err + failure.encode(),
                    streams.out_dropped,
                    streams.err_dropped,
                    streams.active,
                )
            emit(
                build_record(
                    run_id=run_id,
                    moment=moment,
                    argv=argv,
                    exit_code=exit_code,
                    duration_seconds=time.monotonic() - started,
                    notes=pending_notes(),
                    streams=streams,
                ),
                config,
            )
        _notes.clear()
