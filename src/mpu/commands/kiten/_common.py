"""`mpu kiten` — общие хелперы: константы команды, coalesce, парсеры/валидаторы,
резолв и автодополнение space/board/lane/column, разбор селектора карточки,
карта колонок для `{column_mapped}`."""

from __future__ import annotations

import datetime
import json as _json
from collections.abc import Callable
from typing import Annotated, cast

import typer

from mpu.lib import env, kaiten_cache
from mpu.lib.kaiten import parse_card_ref

# Публичный API модуля для остального пакета `kiten` (в т.ч. `_`-имена: исторически
# module-private в монолите, теперь общие для подмодулей — `__all__` помечает экспорт).
__all__ = [
    "COMMAND_NAME",
    "COMMAND_SUMMARY",
    "DEFAULT_ROLE_ID",
    "_board_id_from_ctx",
    "_check_date",
    "_complete_board",
    "_complete_column",
    "_complete_lane",
    "_complete_role",
    "_complete_space",
    "_env_int",
    "_env_str",
    "_load_column_map",
    "_parse_card_ref",
    "_resolve_board",
    "_resolve_column",
    "_resolve_lane",
    "_resolve_role",
    "_resolve_space",
    "build_updated_window",
    "coalesce",
]

# Опции, повторяющиеся между подкомандами kiten (общий каталог CLI — mpu.lib.cli_opts;
# здесь — то, что осмысленно только для Kaiten).
_CARD_HELP = "ID карточки или URL btlz.kaiten.ru (короткий/глубокий)"
CardArg = Annotated[str, typer.Argument(help=_CARD_HELP)]
# Тот же аргумент там, где карточка необязательна (напр. `time ls` без селектора — все карточки).
CardArgOpt = Annotated[str | None, typer.Argument(help=_CARD_HELP)]
JsonOpt = Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")]

COMMAND_NAME = "mpu kiten"
COMMAND_SUMMARY = (
    "Kaiten: `ls` — мои карточки (member); `card` — одна карточка; `comment` — комментарий; "
    "`move`/`ready`/`review` — перемещение (+ лог в журнал); `time` — учёт времени и таймер; "
    "`spaces`/`boards`/`lanes`/`columns`/`roles` — справочник; `whoami`"
)

# Роль записи учёта времени по умолчанию — «Техподдержка» (GET /user-roles).
# Именно ID, а не название: переименование роли на доске не должно ломать `mpu kiten time`.
DEFAULT_ROLE_ID = 12058


def coalesce[T](*values: T | None) -> T | None:
    """Первое не-None значение (декларативный precedence: CLI > env > дефолт)."""
    return next((v for v in values if v is not None), None)


def _parse_int(name: str, value: str) -> int:
    try:
        return int(value)
    except ValueError:
        raise typer.BadParameter(f"{name}={value!r}: ожидалось целое число") from None


def _env_int(env_get: Callable[[str], str | None], name: str) -> int | None:
    raw = env_get(name)
    return _parse_int(name, raw.strip()) if raw and raw.strip() else None


def _env_str(env_get: Callable[[str], str | None], name: str) -> str | None:
    raw = env_get(name)
    return raw.strip() if raw and raw.strip() else None


# ── Окно активности --date-from / --date-to (YYYY-MM-DD → updated_after/before) ──


def _check_date(flag: str, value: str) -> str:
    """Валидировать YYYY-MM-DD; вернуть нормализованную строку, иначе BadParameter."""
    try:
        return datetime.date.fromisoformat(value).isoformat()
    except ValueError:
        raise typer.BadParameter(f"{flag}={value!r}: ожидается YYYY-MM-DD") from None


def build_updated_window(
    date_from: str | None, date_to: str | None
) -> tuple[str | None, str | None]:
    """`--date-from`/`--date-to` (YYYY-MM-DD) → `(updated_after, updated_before)` в ISO 8601 (UTC).

    Окно по последней активности карточки (поле `updated`). Границы инклюзивные: from —
    начало дня (`T00:00:00Z`), to — конец дня (`T23:59:59Z`). `None` остаётся `None` (ось
    не фильтруется), так что без обоих флагов `ls` работает как раньше. Чистая функция
    (только валидация + формат), сети нет — тестируется без моков. Невалидная дата —
    `BadParameter`, как у `_resolve_*`.
    """
    updated_after = f"{_check_date('--date-from', date_from)}T00:00:00Z" if date_from else None
    updated_before = f"{_check_date('--date-to', date_to)}T23:59:59Z" if date_to else None
    return updated_after, updated_before


# ── Автодополнение / резолв --space, --board (ID или подстрока названия из кэша) ─


def _complete_space(incomplete: str) -> list[tuple[str, str]]:
    """TAB по --space: значение=ID, hint=title из кэша (`mpu init` / `mpu kiten spaces`)."""
    try:
        return kaiten_cache.filter_refs(incomplete, kaiten_cache.cached_spaces())
    except Exception:  # TAB-completion не должен падать ни при какой ошибке
        return []


def _complete_board(ctx: typer.Context, incomplete: str) -> list[tuple[str, str]]:
    """TAB по --board: доски из кэша; если уже задан --space — фильтр по нему."""
    try:
        space_ref = ctx.params.get("space")
        space_id: int | None = None
        if isinstance(space_ref, str) and space_ref.strip():
            try:
                space_id = kaiten_cache.resolve_ref(
                    space_ref, kaiten_cache.cached_spaces(), kind="space"
                )
            except ValueError:
                space_id = None
        return kaiten_cache.filter_refs(incomplete, kaiten_cache.cached_boards(space_id))
    except Exception:  # TAB-completion не должен падать ни при какой ошибке
        return []


def _resolve_space(ref: str | None) -> int | None:
    """`--space` (ID или подстрока) → space_id. ValueError резолва → BadParameter."""
    if ref is None:
        return None
    try:
        return kaiten_cache.resolve_ref(ref, kaiten_cache.cached_spaces(), kind="space")
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


def _resolve_board(ref: str | None) -> int | None:
    """`--board` (ID или подстрока) → board_id. ValueError резолва → BadParameter."""
    if ref is None:
        return None
    try:
        return kaiten_cache.resolve_ref(ref, kaiten_cache.cached_boards(), kind="board")
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


def _complete_role(incomplete: str) -> list[tuple[str, str]]:
    """TAB по --role: роли из кэша (`mpu init` / `mpu kiten roles`)."""
    try:
        return kaiten_cache.filter_refs(incomplete, kaiten_cache.cached_roles())
    except Exception:  # TAB-completion не должен падать ни при какой ошибке
        return []


def _resolve_role(ref: str | None) -> int:
    """`--role` (ID или подстрока названия) → role_id. Всегда даёт роль: есть дефолт.

    Precedence: явный `--role` → env `KITEN_TIME_ROLE` → `DEFAULT_ROLE_ID` (Техподдержка).
    Дефолт — числовой ID, а не название: роль на доске могут переименовать, и тогда
    зашитое имя обвалило бы каждый `time add`.

    Нерезолвимое значение env НЕ откатывается молча на дефолт — это ошибка с именем
    переменной, иначе опечатка в `.env` тихо списывала бы время не на ту роль.
    """
    if ref is None:
        env_ref = _env_str(env.get, "KITEN_TIME_ROLE")
        if env_ref is None:
            return DEFAULT_ROLE_ID
        try:
            return kaiten_cache.resolve_ref(env_ref, kaiten_cache.roles(), kind="role")
        except ValueError as e:
            raise typer.BadParameter(f"KITEN_TIME_ROLE: {e}") from None
    try:
        return kaiten_cache.resolve_ref(ref, kaiten_cache.roles(), kind="role")
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


def _board_id_from_ctx(ctx: typer.Context) -> int | None:
    """Эффективная доска для скоупа `--lane` в completion.

    Precedence как у самого `ls`: явный `--board` из текущей строки → иначе env
    `KITEN_LS_BOARD_ID` → иначе None (все дорожки). Best-effort, None при неоднозначности.
    """
    board_ref = ctx.params.get("board")
    if isinstance(board_ref, str) and board_ref.strip():
        try:
            return kaiten_cache.resolve_ref(board_ref, kaiten_cache.cached_boards(), kind="board")
        except ValueError:
            return None
    return _env_int(env.get, "KITEN_LS_BOARD_ID")


def _complete_lane(ctx: typer.Context, incomplete: str) -> list[tuple[str, str]]:
    """TAB по --lane: дорожки из кэша; если задан --board — только дорожки этой доски."""
    try:
        return kaiten_cache.filter_refs(
            incomplete, kaiten_cache.cached_lanes(_board_id_from_ctx(ctx))
        )
    except Exception:  # TAB-completion не должен падать ни при какой ошибке
        return []


def _resolve_lane(ref: str | None, board_id: int | None) -> int | None:
    """`--lane` (ID или подстрока) → lane_id в скоупе доски. ValueError резолва → BadParameter."""
    if ref is None:
        return None
    try:
        return kaiten_cache.resolve_ref(ref, kaiten_cache.cached_lanes(board_id), kind="lane")
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


def _complete_column(ctx: typer.Context, incomplete: str) -> list[tuple[str, str]]:
    """TAB по --column: колонки из кэша; если задан --board (или env) — только этой доски."""
    try:
        return kaiten_cache.filter_refs(
            incomplete, kaiten_cache.cached_columns(_board_id_from_ctx(ctx))
        )
    except Exception:  # TAB-completion не должен падать ни при какой ошибке
        return []


def _resolve_column(ref: str | None, board_id: int | None) -> int | None:
    """`--column` (ID или подстрока) → column_id в скоупе доски. ValueError → BadParameter."""
    if ref is None:
        return None
    try:
        return kaiten_cache.resolve_ref(ref, kaiten_cache.cached_columns(board_id), kind="column")
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


def _parse_card_ref(ref: str) -> int:
    """Селектор карточки → id; ValueError парсера → BadParameter."""
    try:
        return parse_card_ref(ref)
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


def _load_column_map() -> dict[str, str]:
    """Маппинг для `{column_mapped}` из .env `KITEN_COLUMN_MAP` (JSON: id-ИЛИ-имя → метка).

    Пусто/некорректный JSON → `{}` (с предупреждением в stderr), `{column_mapped}` тогда
    равен исходному имени колонки. Ключи нормализуются в строки (id или название колонки).
    """
    raw = env.get("KITEN_COLUMN_MAP")
    if not raw or not raw.strip():
        return {}
    try:
        data = _json.loads(raw)
    except _json.JSONDecodeError as e:
        typer.echo(f"{COMMAND_NAME} ls: некорректный JSON в KITEN_COLUMN_MAP: {e}", err=True)
        return {}
    if not isinstance(data, dict):
        typer.echo(f"{COMMAND_NAME} ls: KITEN_COLUMN_MAP должен быть JSON-объектом", err=True)
        return {}
    data_dict = cast("dict[str, object]", data)
    return {str(k): str(v) for k, v in data_dict.items()}
