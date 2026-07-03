"""`mpu kiten` — Kaiten (доска btlz.kaiten.ru) из терминала.

- `mpu kiten ls`     — карточки, где я участник (member). Фильтры по умолчанию из
  `.env` (KITEN_LS_*); CLI-флаг переопределяет **только свою** ось, остальные берутся
  из `.env`. `--space`/`--board`/`--lane`/`--column` принимают ID ИЛИ подстроку названия
  (резолв по кэшу). `--date-from`/`--date-to` (YYYY-MM-DD, CLI-only) — окно активности
  (`updated`); их наличие включает **глобальный** поиск (по всем доскам, плюс архив и
  завершённые), env-скоуп игнорируется, но явные флаги всё ещё сужают. Без даты вывод как
  раньше. Вывод: `--json` (машинный); `--only-url` (строки `[title](url)`); `--md`
  (GFM-таблица); `--format '<шаблон>'` — произвольный шаблон с плейсхолдерами `{n}` `{id}`
  `{title}` `{url}` `{state}` `{due}` `{column}` `{column_mapped}`. `{column_mapped}` берёт
  метку из `.env` `KITEN_COLUMN_MAP` (JSON: id-ИЛИ-имя колонки → метка), иначе исходное имя.
- `mpu kiten card <selector>` — одна карточка наглядно: markdown + GFM-таблицы + инлайн-
  скриншоты (notebook-flow через rich + term-image). Селектор — id ИЛИ URL btlz.kaiten.ru
  (короткий `/65634936` или глубокий `.../boards/card/65634936?filter=…`). `--md` — чистый
  GFM для LLM (ссылки/таблицы целы, без ANSI; авто при пайпе); `--json` — сырой JSON.
- `mpu kiten comment <selector> <-m TEXT | -F FILE>` — добавить комментарий от своего имени
  (автор — владелец `KITEN_API_KEY`). Тело из `-m`/`--message` ИЛИ `-F`/`--body-file`
  (`-` = stdin), как у `mpu mr comment`. Селектор — как у `card`.
- `mpu kiten move <selector> [--lane L] [--column C] [--board B]` — переместить карточку по
  дорожке / колонке / доске (хотя бы одна ось). `--lane`/`--column` принимают ID или подстроку,
  резолв в скоупе целевой доски (`--board`, иначе текущая доска карточки).
- `mpu kiten spaces` — список пространств (ID — title); обновляет кэш автодополнения.
- `mpu kiten boards` — список досок (ID — title), `--space` фильтрует; обновляет кэш.
- `mpu kiten lanes`  — список дорожек (ID — title), `--space`/`--board` фильтруют; обновляет кэш.
- `mpu kiten columns`— список колонок (ID — title), `--space`/`--board` фильтруют; обновляет кэш.
- `mpu kiten whoami` — мой id / имя / email по токену (GET /users/current).

Справочник spaces/boards/lanes/columns для `--space`/`--board`/`--lane`/`--column` (резолв
подстроки + shell completion) кэшируется в `~/.config/mpu/mpu.db` командой `mpu init` или
`mpu kiten spaces/boards/lanes/columns` (см. `mpu.lib.kaiten_cache`). Дорожки и колонки
скоупятся по доске: при заданном `--board` (или env KITEN_LS_BOARD_ID) автодополнение
`--lane`/`--column` показывает только сущности этой доски.

ENV (~/.config/mpu/.env): KITEN_API_KEY, KITEN_BASE_URL, KITEN_LS_CONDITION,
KITEN_LS_STATES, KITEN_LS_SPACE_ID, KITEN_LS_BOARD_ID, KITEN_LS_LANE_ID, KITEN_LS_COLUMN_ID,
KITEN_COLUMN_MAP (JSON id-или-имя колонки → метка, для `--format {column_mapped}`).

Стиль: фильтры сводятся декларативно через `coalesce(cli, env, default)` поосно, таблица
описана data-driven спекой колонок `_COLUMNS` и рендерится через rich.
"""

import importlib

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import (
    COMMAND_NAME,
    COMMAND_SUMMARY,
    _board_id_from_ctx,
    _complete_board,
    _complete_column,
    _complete_lane,
    _complete_space,
    build_updated_window,
    coalesce,
)
from mpu.commands.kiten._render import _card_to_markdown

# Регистрация команд на общий `app`: импорт подмодулей ради side-effect'а (@app.command)
# в ИСХОДНОМ порядке — `--help` печатает команды в порядке регистрации (TyperGroup хранит
# порядок вставки). Через importlib, а не import-выражения, чтобы isort не переупорядочил
# и не сломал порядок команд. Группа `field` (add_typer) всегда печатается последней.
for _name in ("ls", "card", "comment", "move", "refs", "field"):
    importlib.import_module(f"{__name__}.{_name}")

from mpu.commands.kiten.comment import (  # noqa: E402
    _expand_all_to_owner,
    expand_all_mention,
    expand_recipients,
    parse_recipients,
    plan_field_actions,
    prepend_recipients,
    read_attachments,
    resolve_comment_text,
)
from mpu.commands.kiten.ls import LsFilters, resolve_ls_filters  # noqa: E402
from mpu.commands.kiten.move import _left_neighbor_column  # noqa: E402

__all__ = [
    "COMMAND_NAME",
    "COMMAND_SUMMARY",
    "LsFilters",
    "_board_id_from_ctx",
    "_card_to_markdown",
    "_complete_board",
    "_complete_column",
    "_complete_lane",
    "_complete_space",
    "_expand_all_to_owner",
    "_left_neighbor_column",
    "app",
    "build_updated_window",
    "coalesce",
    "expand_all_mention",
    "expand_recipients",
    "parse_recipients",
    "plan_field_actions",
    "prepend_recipients",
    "read_attachments",
    "resolve_comment_text",
    "resolve_ls_filters",
]
