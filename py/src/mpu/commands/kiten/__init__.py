"""`mpu kiten` — Kaiten (доска btlz.kaiten.ru) из терминала.

- `mpu kiten status` — вся моя работа одной таблицей-матрицей по ВСЕМ доскам: строка —
  карточка, столбцы — канонические этапы (печатаются только непустые), `●` — текущий.
  Объединяет три источника: назначенное (участник/ответственный, включая ещё не тронутое),
  карточки, где я списывал время, и карточки, которые я комментировал/двигал — колонка
  `ИСТ` показывает, какой именно (👤 / 🕒 / 📝). Второй и третий источники ловят чужие
  карточки без членства (ревью, поддержка), которых `ls` не видит. Колонка `ВРЕМЯ` — всё
  МОЁ время по карточке за `--time-since` (дефолт 365d), а `--since` (дефолт 7d) — окно
  попадания в таблицу; живые (не архивные) карточки в неё входят всегда. Форма вывода —
  одна ось `--out matrix|group|json|md|url` (`group` — секции по этапам) плюс
  `--format '<шаблон>'`; сужение — `--stage` (queue|estimate|work|review|test|dev|preprod|
  done), `--board`, `--source assigned|time|activity|touch`, `--only open|done`. Значение
  `touch` — карточки, попавшие в выдачу ТОЛЬКО из ленты действий (не назначена, время не
  списывал): так находится «написал не в ту карточку»; их число печатается в подвале. Ширина
  подгоняется под терминал: сжимается заголовок, затем подписи этапов (полные → 3 буквы →
  1 буква с легендой), в последнюю очередь убирается дорожка. Правила «колонка → этап»
  переопределяются `.env` `KITEN_STAGE_MAP` (JSON: имя колонки → этап).
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
- `mpu kiten time …` — учёт времени карточки (раздел «Учёт времени» + кнопка таймера):
  `ls` — записи (по умолчанию свои; `--all` — всех; без селектора — сводка за период,
  тогда `--date-from` обязателен), `add`/`edit`/`rm` — завести/поправить/удалить запись,
  `start`/`status`/`stop`/`discard` — таймер. Тип работы — `--role` (ID или подстрока
  названия, см. `mpu kiten roles`; по умолчанию env `KITEN_TIME_ROLE`, иначе «Техподдержка»).
  Длительность гибкая: `3h` / `1h15m` / `1:15` / `90` (минуты) / `2.5h`. Роль и описание,
  заданные при `start`, подставляются при `stop` (API таймера роль не хранит). `--time` у
  `stop` записывает заданную длительность вместо фактической, сдвигая метки, как это делает
  поле «Время (чч:мм)» в вебе.
- `mpu kiten roles` — роли компании = типы работ (ID — title); обновляет кэш автодополнения.
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
KITEN_COLUMN_MAP (JSON id-или-имя колонки → метка, для `--format {column_mapped}`),
KITEN_STAGE_MAP (JSON имя колонки → канонический этап, для `status`),
KITEN_READY_COLUMN / KITEN_REVIEW_COLUMN (колонки для `ready`/`review`),
KITEN_TIME_ROLE (тип работы по умолчанию для `time`).

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
    _complete_role,
    _complete_space,
    _resolve_role,
    build_updated_window,
    coalesce,
)
from mpu.commands.kiten._render import _card_to_markdown

# Регистрация команд на общий `app`: импорт подмодулей ради side-effect'а (@app.command)
# в ИСХОДНОМ порядке — `--help` печатает команды в порядке регистрации (TyperGroup хранит
# порядок вставки). Через importlib, а не import-выражения, чтобы isort не переупорядочил
# и не сломал порядок команд. Группы (add_typer: `time`, `field`) печатаются последними.
#
# `timelog` стоит ДО `move` намеренно: `move` импортирует из него остановку таймера для
# `close`, то есть зарегистрировал бы группу `time` побочным эффектом — и порядок в `--help`
# начал бы зависеть от направления импорта, а не от этого списка.
for _name in ("status", "ls", "card", "comment", "timelog", "move", "refs", "field"):
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
from mpu.commands.kiten.timelog import (  # noqa: E402
    build_time_log_patch,
    default_for_date,
    summarise_logs,
)

__all__ = [
    "COMMAND_NAME",
    "COMMAND_SUMMARY",
    "LsFilters",
    "_board_id_from_ctx",
    "_card_to_markdown",
    "_complete_board",
    "_complete_column",
    "_complete_lane",
    "_complete_role",
    "_complete_space",
    "_expand_all_to_owner",
    "_left_neighbor_column",
    "_resolve_role",
    "app",
    "build_time_log_patch",
    "build_updated_window",
    "coalesce",
    "default_for_date",
    "expand_all_mention",
    "expand_recipients",
    "parse_recipients",
    "plan_field_actions",
    "prepend_recipients",
    "read_attachments",
    "resolve_comment_text",
    "resolve_ls_filters",
    "summarise_logs",
]
