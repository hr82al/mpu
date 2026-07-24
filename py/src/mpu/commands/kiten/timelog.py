"""`mpu kiten time` — учёт времени карточки Kaiten: записи вручную и таймер.

Соответствие интерфейсу Kaiten: `ls`/`add`/`edit`/`rm` — раздел карточки «Учёт времени»
(таблица «Записи, часы»), `start`/`status`/`stop`/`discard` — кнопка таймера в шапке карточки.

Модуль называется `timelog`, а не `time`: имя `time` внутри пакета, который сам занимается
арифметикой дат, читалось бы как stdlib-модуль. Имя команды при этом `time` (см. `time_app`).

Единица времени в API — МИНУТА (`time_spent`); на вход принимаем гибкую форму
(`3h` / `1h15m` / `1:15` / `90` / `2.5h`, см. `lib/duration.parse_minutes`).
"""

from __future__ import annotations

import datetime
import math
from typing import TYPE_CHECKING, Annotated

import typer
from rich.console import Console
from rich.table import Table

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import (
    COMMAND_NAME,
    CardArg,
    CardArgOpt,
    JsonOpt,
    _check_date,
    _complete_role,
    _parse_card_ref,
    _resolve_role,
    build_updated_window,
)
from mpu.lib import kaiten_cache, kaiten_links, store
from mpu.lib.cli_err import die
from mpu.lib.cli_out import print_json
from mpu.lib.duration import DurationParseError, format_minutes, parse_minutes
from mpu.lib.kaiten import KaitenAPIError, KaitenClient, card_url
from mpu.lib.kiten_status import MSK

if TYPE_CHECKING:
    from mpu.lib.kaiten_models import KaitenCardDetail, KaitenTimeLog, KaitenTimer

time_app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=(
        "Учёт времени карточки: `ls`/`add`/`edit`/`rm` — записи; "
        "`start`/`status`/`stop`/`discard` — таймер. Тип работы — `--role` "
        "(имя или ID, см. `mpu kiten roles`; по умолчанию env KITEN_TIME_ROLE "
        "или «Техподдержка»). Длительность: 3h | 1h15m | 1:15 | 90 (минуты) | 2.5h."
    ),
)
app.add_typer(time_app, name="time")

_ROLE_HELP = (
    "Тип работы: ID или подстрока названия (см. `mpu kiten roles`); "
    "по умолчанию env KITEN_TIME_ROLE или «Техподдержка»"
)


# ── Чистые хелперы (без сети и БД, тестируемые) ────────────────────────────────


def default_for_date(now: datetime.datetime | None = None) -> str:
    """Дата записи по умолчанию — сегодня ПО МОСКВЕ (`YYYY-MM-DD`).

    Не `date.today()`: `for_date` — ярлык рабочего дня, компания работает в МСК, и веб-интерфейс
    Kaiten шлёт `tz_offset: 180`. На машине в другой зоне `date.today()` молча разошёлся бы с тем,
    что человек видит в браузере. Следствие: с 00:00 до 03:00 МСК день на единицу впереди UTC.
    """
    moment = datetime.datetime.now(MSK) if now is None else now.astimezone(MSK)
    return moment.date().isoformat()


def summarise_logs(
    logs: list[KaitenTimeLog],
    *,
    user_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    role_id: int | None = None,
) -> tuple[list[KaitenTimeLog], int]:
    """Отфильтровать записи и посчитать сумму минут. Границы дат инклюзивные.

    `user_id` — оставить только записи этого пользователя (API отдаёт записи всей компании).
    Сравнение дат лексикографическое: обе стороны уже нормализованы в `YYYY-MM-DD`.
    """
    picked = [
        log
        for log in logs
        if (user_id is None or log.user_id == user_id)
        and (role_id is None or log.role_id == role_id)
        and (date_from is None or log.for_date >= date_from)
        and (date_to is None or log.for_date <= date_to)
    ]
    return picked, sum(log.time_spent for log in picked)


def parse_timestamp(raw: str) -> datetime.datetime:
    """Метка времени Kaiten (`2026-07-20T11:41:38.289Z`) → aware datetime в ЕЁ зоне."""
    return datetime.datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)


def format_timestamp(moment: datetime.datetime) -> str:
    """Aware datetime → метка в формате Kaiten, миллисекунды ВСЕГДА `.000`.

    Обнулённые миллисекунды не косметика: длительность сервер считает как
    `finished_at - started_at` с округлением ВВЕРХ до минуты, поэтому лишняя `.001`
    превратила бы ровные N минут в N+1.
    """
    exact = moment.replace(microsecond=0)
    if exact.utcoffset() == datetime.timedelta(0):
        return exact.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return exact.isoformat(timespec="milliseconds")


def elapsed_minutes(started_at: str, now: datetime.datetime) -> int:
    """Сколько натикало у запущенного таймера, в минутах. Округление ВВЕРХ — как у Kaiten
    (20 секунд работы он записывает как 1 минуту)."""
    delta = now - parse_timestamp(started_at)
    return max(0, math.ceil(delta.total_seconds() / 60))


def timer_window(
    started_at: str, now: datetime.datetime, minutes: int | None
) -> tuple[str | None, str]:
    """Метки для остановки таймера: `(started_at для PATCH или None, finished_at)`.

    `minutes is None` — записать фактическое: старт не трогаем (None ⇒ не шлём его вовсе),
    финиш = сейчас, длительность досчитает сервер.

    `minutes` задано — повторяем поведение веб-интерфейса (поле «Время (чч:мм)»): старт
    сохраняем, усекая до целой минуты, финиш = старт + длительность. Единственное отступление
    от веба: если такой финиш попал БЫ В БУДУЩЕЕ (заявили больше, чем натикало), якорем
    становится «сейчас», а назад сдвигается старт — запись не должна получать будущую метку.

    Арифметика ведётся в зоне ИСХОДНОЙ метки и в ней же сериализуется: посчитать её в наивных
    московских терминах поверх UTC-метки значило бы молча увести запись на три часа.
    """
    start = parse_timestamp(started_at)
    finish_now = now.astimezone(start.tzinfo)
    if minutes is None:
        return None, format_timestamp(finish_now)
    start = start.replace(second=0, microsecond=0)
    finish = start + datetime.timedelta(minutes=minutes)
    if finish > finish_now:
        finish = finish_now.replace(second=0, microsecond=0)
        start = finish - datetime.timedelta(minutes=minutes)
    return format_timestamp(start), format_timestamp(finish)


def build_time_log_patch(
    *,
    minutes: int | None = None,
    for_date: str | None = None,
    role_id: int | None = None,
    comment: str | None = None,
) -> dict[str, object]:
    """Тело PATCH записи из заданных осей; None-оси не попадают (частичное обновление).

    Пустая строка в `comment` — осмысленное значение (очистка), поэтому проверка именно
    на None. Ни одной оси → ValueError: пустой PATCH слать нельзя.
    """
    body: dict[str, object] = {}
    if minutes is not None:
        body["time_spent"] = minutes
    if for_date is not None:
        body["for_date"] = for_date
    if role_id is not None:
        body["role_id"] = role_id
    if comment is not None:
        body["comment"] = comment
    if not body:
        raise ValueError("нечего обновлять: не задано ни одно поле")
    return body


# ── Вспомогательное (тонкие обёртки над общим) ─────────────────────────────────


def _parse_duration(flag: str, raw: str) -> int:
    """Гибкая длительность → минуты; ошибка парсера → BadParameter с именем флага."""
    try:
        return parse_minutes(raw)
    except DurationParseError as e:
        raise typer.BadParameter(f"{flag} {e}") from None


def role_name(role_id: int | None, cached: list[tuple[int, str]] | None = None) -> str:
    """Название роли по ID из кэша справочника; неизвестная → сам ID строкой.

    Нужно потому, что ответы POST/PATCH записи вложенный объект `role` НЕ несут (в отличие
    от GET списка) — без этого свежесозданная запись печаталась бы с голым числом.
    """
    if role_id is None:
        return ""
    rows = kaiten_cache.cached_roles() if cached is None else cached
    return next((name for rid, name in rows if rid == role_id), str(role_id))


def _role_label(log: KaitenTimeLog) -> str:
    return log.role_name or role_name(log.role_id)


def _plural_records(count: int) -> str:
    """«1 запись» / «2 записи» / «5 записей» — согласование числительного с существительным."""
    tail_two, tail_one = count % 100, count % 10
    if 11 <= tail_two <= 14:  # noqa: PLR2004 — исключение 11–14 в русском счёте
        return "записей"
    if tail_one == 1:
        return "запись"
    if 2 <= tail_one <= 4:  # noqa: PLR2004 — форма родительного единственного (2–4)
        return "записи"
    return "записей"


def _log_payload(log: KaitenTimeLog) -> dict[str, object]:
    """Запись → JSON-словарь для `--json` (плоский, без вложенных объектов wire)."""
    return {
        "id": log.id,
        "card_id": log.card_id,
        "for_date": log.for_date,
        "minutes": log.time_spent,
        "role_id": log.role_id,
        "role": log.role_name,
        "user_id": log.user_id,
        "user": log.user_name,
        "comment": log.comment,
    }


def _print_logs(logs: list[KaitenTimeLog], total: int, *, with_user: bool) -> None:
    """Таблица записей + строка итога. Пустой список — `(пусто)`, как у `field ls`."""
    if not logs:
        typer.echo("(пусто)")
        return
    table = Table(box=None)
    headers = ["ID", "ДАТА", "ВРЕМЯ", "РОЛЬ"] + (["ПОЛЬЗОВАТЕЛЬ"] if with_user else [])
    headers.append("КОММЕНТАРИЙ")
    for header in headers:
        table.add_column(header, overflow="fold")
    for log in logs:
        row = [str(log.id), log.for_date, format_minutes(log.time_spent), _role_label(log)]
        if with_user:
            row.append(log.user_name or str(log.user_id or ""))
        row.append(log.comment)
        table.add_row(*row)
    Console().print(table)
    typer.echo(f"итого: {format_minutes(total)} ({len(logs)} {_plural_records(len(logs))})")


def _touch_hint(
    card_id: int,
    *,
    timer_id: int | None = None,
    role_id: int | None = None,
    comment: str | None = None,
    started_at: str | None = None,
) -> None:
    """Записать/обновить подсказку по карточке. None-поля сохраняют прежнее значение."""
    with store.store() as conn:
        store.bootstrap(conn)  # идемпотентно: таблица может отсутствовать без mpu init
        kaiten_links.record_time_hint(
            conn,
            card_id,
            timer_id=timer_id,
            role_id=role_id,
            comment=comment,
            started_at=started_at,
        )


def _my_user_id(client: KaitenClient) -> int:
    """ID владельца токена — для фильтра «только мои записи» и проверки владельца."""
    return client.current_user().id


def _find_log(logs: list[KaitenTimeLog], log_id: int) -> KaitenTimeLog | None:
    return next((log for log in logs if log.id == log_id), None)


def _describe(log: KaitenTimeLog) -> str:
    """Одна строка про запись: дата · время · роль · «комментарий»."""
    parts = [log.for_date, format_minutes(log.time_spent), _role_label(log)]
    if log.comment:
        parts.append(f"«{log.comment}»")
    return " · ".join(p for p in parts if p)


# ── Команды: записи ────────────────────────────────────────────────────────────


@time_app.command("ls")
def time_ls(
    selector: CardArgOpt = None,
    show_all: Annotated[
        bool, typer.Option("--all", help="Записи всех пользователей, а не только мои")
    ] = False,
    date_from: Annotated[
        str | None, typer.Option("--date-from", help="Нижняя граница даты записи (YYYY-MM-DD)")
    ] = None,
    date_to: Annotated[
        str | None, typer.Option("--date-to", help="Верхняя граница даты записи (YYYY-MM-DD)")
    ] = None,
    role: Annotated[
        str | None,
        typer.Option("--role", help="Фильтр по типу работы", autocompletion=_complete_role),
    ] = None,
    out_json: JsonOpt = False,
) -> None:
    """Записи учёта времени: по карточке или сводкой за период по всем карточкам.

    Kaiten отдаёт записи ВСЕЙ компании, поэтому чужие показываются лишь по `--all`:
    выдавать чужие часы за свои в учёте времени — худший из возможных дефолтов.

    Без селектора — сводка за период (`--date-from` обязателен). Карточки берутся из тех, где
    я участник и которые обновлялись в этом окне, плюс из локальных подсказок. Глобального
    списка записей в API нет (403), поэтому каждая карточка опрашивается отдельно — счётчик
    просмотренных печатается в подвале, чтобы цена была видна. Чего сводка НЕ увидит: карточку,
    где я не участник и время на которую списал не через этот CLI.
    """
    role_id = _resolve_role(role) if role is not None else None
    date_from = _check_date("--date-from", date_from) if date_from else None
    date_to = _check_date("--date-to", date_to) if date_to else None
    client = KaitenClient.from_env()

    if selector is None:
        if date_from is None:
            raise typer.BadParameter(
                "без карточки нужен период: --date-from YYYY-MM-DD "
                "(иначе пришлось бы опросить все карточки подряд)"
            )
        _summary(client, show_all, date_from, date_to, role_id, out_json=out_json)
        return

    card_id = _parse_card_ref(selector)
    try:
        logs = client.list_time_logs(card_id)
        me = None if show_all else _my_user_id(client)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} time ls: kaiten error: {e}")
    picked, total = summarise_logs(
        logs, user_id=me, date_from=date_from, date_to=date_to, role_id=role_id
    )
    if out_json:
        print_json({"total_minutes": total, "logs": [_log_payload(log) for log in picked]})
        return
    _print_logs(picked, total, with_user=show_all)


def _summary_card_ids(
    client: KaitenClient, me: int, date_from: str, date_to: str | None
) -> list[int]:
    """Карточки-кандидаты для сводки: где я участник и было обновление в окне + подсказки.

    Записи времени бампают `updated` карточки (проверено), поэтому окно активности их ловит.
    Подсказки добавлены как подстраховка для карточек, где я не в участниках.
    """
    after, before = build_updated_window(date_from, date_to)
    ids: list[int] = []
    try:
        cards = client.list_cards(member_ids=str(me), updated_after=after, updated_before=before)
    except KaitenAPIError:
        cards = []  # best-effort: подсказки ниже всё равно дадут что-то показать
    ids.extend(card.id for card in cards)
    with store.store() as conn:
        store.bootstrap(conn)
        hints = kaiten_links.list_time_hints(conn)
    known = set(ids)
    ids.extend(h.card_id for h in hints if h.card_id not in known)
    return ids


def _summary(
    client: KaitenClient,
    show_all: bool,
    date_from: str,
    date_to: str | None,
    role_id: int | None,
    *,
    out_json: bool,
) -> None:
    """Сводка по нескольким карточкам: по запросу на карточку, сбои отдельных — не фатальны."""
    try:
        me = _my_user_id(client)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} time ls: kaiten error: {e}")
    card_ids = _summary_card_ids(client, me, date_from, date_to)

    rows: list[KaitenTimeLog] = []
    scanned = 0
    for card_id in card_ids:
        try:
            logs = client.list_time_logs(card_id)
        except KaitenAPIError:
            continue  # недоступная карточка не должна ронять всю сводку
        scanned += 1
        picked, _ = summarise_logs(
            logs,
            user_id=None if show_all else me,
            date_from=date_from,
            date_to=date_to,
            role_id=role_id,
        )
        rows.extend(picked)
    rows.sort(key=lambda log: (log.for_date, log.card_id, log.id))
    total = sum(log.time_spent for log in rows)

    if out_json:
        print_json(
            {
                "total_minutes": total,
                "scanned_cards": scanned,
                "logs": [_log_payload(log) for log in rows],
            }
        )
        return
    if not rows:
        typer.echo(f"(пусто) · просмотрено карточек: {scanned}")
        return
    table = Table(box=None)
    headers = ["ДАТА", "КАРТОЧКА", "ВРЕМЯ", "РОЛЬ"] + (["ПОЛЬЗОВАТЕЛЬ"] if show_all else [])
    headers.append("КОММЕНТАРИЙ")
    for header in headers:
        table.add_column(header, overflow="fold")
    for log in rows:
        row = [
            log.for_date,
            str(log.card_id),
            format_minutes(log.time_spent),
            _role_label(log),
        ]
        if show_all:
            row.append(log.user_name or str(log.user_id or ""))
        row.append(log.comment)
        table.add_row(*row)
    Console().print(table)
    typer.echo(
        f"итого: {format_minutes(total)} ({len(rows)} {_plural_records(len(rows))}"
        f", просмотрено карточек: {scanned})"
    )


@time_app.command("add")
def time_add(
    selector: CardArg,
    duration: Annotated[
        str, typer.Argument(help="Длительность: 3h | 1h15m | 1:15 | 90 (минуты) | 2.5h")
    ],
    date: Annotated[
        str | None,
        typer.Option("--date", help="Дата записи (YYYY-MM-DD); по умолчанию сегодня по МСК"),
    ] = None,
    role: Annotated[
        str | None, typer.Option("--role", help=_ROLE_HELP, autocompletion=_complete_role)
    ] = None,
    comment: Annotated[
        str, typer.Option("--comment", "-m", help="Что было сделано (необязательно)")
    ] = "",
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Показать намеченное, ничего не записывая")
    ] = False,
) -> None:
    """Добавить запись учёта времени вручную.

    Дата по умолчанию — сегодня ПО МОСКВЕ (не по локальной зоне машины): именно этот день
    показывает веб-интерфейс. Дата в будущем не блокируется, но о ней предупреждаем —
    это почти всегда опечатка в годе.
    """
    card_id = _parse_card_ref(selector)
    minutes = _parse_duration("--time", duration)
    for_date = _check_date("--date", date) if date else default_for_date()
    role_id = _resolve_role(role)
    if for_date > default_for_date():
        typer.echo(f"внимание: дата {for_date} в будущем", err=True)

    client = KaitenClient.from_env()
    url = card_url(client.base_url, card_id)
    if dry_run:
        typer.echo(
            f"dry-run: +{format_minutes(minutes)} · {for_date} · {role_name(role_id)} · {url}"
        )
        return
    try:
        created = client.add_time_log(
            card_id, for_date=for_date, minutes=minutes, role_id=role_id, comment=comment
        )
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} time add: kaiten error: {e}")
    _touch_hint(card_id, role_id=role_id)
    typer.echo(
        f"ok: +{format_minutes(created.time_spent)} · {created.for_date} · "
        f"{_role_label(created)} · запись {created.id} · {url}"
    )


@time_app.command("edit")
def time_edit(
    selector: CardArg,
    log_id: Annotated[int, typer.Argument(help="ID записи (см. `mpu kiten time ls`)")],
    duration: Annotated[
        str | None,
        typer.Option("--time", help="Новая длительность: 3h | 1h15m | 1:15 | 90 | 2.5h"),
    ] = None,
    date: Annotated[
        str | None, typer.Option("--date", help="Новая дата записи (YYYY-MM-DD)")
    ] = None,
    role: Annotated[
        str | None, typer.Option("--role", help=_ROLE_HELP, autocompletion=_complete_role)
    ] = None,
    comment: Annotated[
        str | None,
        typer.Option("--comment", "-m", help="Новый комментарий; пустая строка — очистить"),
    ] = None,
    force: Annotated[
        bool, typer.Option("--force", help="Править запись другого пользователя")
    ] = False,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Показать намеченное, ничего не записывая")
    ] = False,
) -> None:
    """Изменить запись учёта времени: любое подмножество из времени, даты, роли, комментария.

    Обновление частичное — незаданные оси не трогаются. `--comment ''` (пустая строка)
    ОЧИЩАЕТ комментарий, тогда как отсутствие флага оставляет прежний: это разные вещи.
    """
    card_id = _parse_card_ref(selector)
    minutes = _parse_duration("--time", duration) if duration is not None else None
    for_date = _check_date("--date", date) if date else None
    role_id = _resolve_role(role) if role is not None else None
    try:
        body = build_time_log_patch(
            minutes=minutes, for_date=for_date, role_id=role_id, comment=comment
        )
    except ValueError:
        raise typer.BadParameter(
            "нужно хотя бы одно из --time / --date / --role / --comment"
        ) from None

    client = KaitenClient.from_env()
    url = card_url(client.base_url, card_id)
    try:
        target = _find_log(client.list_time_logs(card_id), log_id)
        if target is None:
            die(
                f"{COMMAND_NAME} time edit: записи {log_id} нет на карточке {card_id}; "
                f"попробуй: {COMMAND_NAME} time ls {card_id}"
            )
        _guard_owner("edit", client, target, force=force)
        if dry_run:
            typer.echo(f"dry-run: запись {log_id} · {_describe(target)} → {_changes(body)} · {url}")
            return
        updated = client.update_time_log(card_id, log_id, body)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} time edit: kaiten error: {e}")
    typer.echo(f"ok: запись {updated.id} · {_changes(body)} · {url}")


def _changes(body: dict[str, object]) -> str:
    """Изменённые оси человекочитаемо — печатаем ТОЛЬКО их, а не всю запись целиком."""
    parts: list[str] = []
    minutes = body.get("time_spent")
    if isinstance(minutes, int):
        parts.append(f"время {format_minutes(minutes)}")
    if (for_date := body.get("for_date")) is not None:
        parts.append(f"дата {for_date}")
    if isinstance(role_id := body.get("role_id"), int):
        parts.append(f"роль {role_name(role_id)}")
    if (comment := body.get("comment")) is not None:
        parts.append(f"комментарий «{comment}»" if comment else "комментарий очищен")
    return " · ".join(parts)


@time_app.command("rm")
def time_rm(
    selector: CardArg,
    log_id: Annotated[int, typer.Argument(help="ID записи (см. `mpu kiten time ls`)")],
    force: Annotated[
        bool, typer.Option("--force", help="Удалить запись другого пользователя")
    ] = False,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Показать намеченное, ничего не записывая")
    ] = False,
) -> None:
    """Удалить запись учёта времени.

    Селектор карточки обязателен: путь записи в API — `/cards/{card}/time-logs/{log}`,
    доступа к записи без карточки нет.

    Печатает удалённую запись целиком — самая дешёвая страховка от опечатки в ID
    (восстановить можно руками через `time add`).
    """
    card_id = _parse_card_ref(selector)
    client = KaitenClient.from_env()
    url = card_url(client.base_url, card_id)
    try:
        logs = client.list_time_logs(card_id)
        target = _find_log(logs, log_id)
        if target is None:
            die(
                f"{COMMAND_NAME} time rm: записи {log_id} нет на карточке {card_id}; "
                f"попробуй: {COMMAND_NAME} time ls {card_id}"
            )
        _guard_owner("rm", client, target, force=force)
        if dry_run:
            typer.echo(f"dry-run: удалить запись {log_id} · {_describe(target)} · {url}")
            return
        client.delete_time_log(card_id, log_id)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} time rm: kaiten error: {e}")
    typer.echo(f"ok: удалена запись {log_id} · {_describe(target)} · {url}")


def _guard_owner(sub: str, client: KaitenClient, log: KaitenTimeLog, *, force: bool) -> None:
    """Запретить правку/удаление чужой записи без `--force`.

    Прицельная защита вместо общего подтверждения: в `kiten` мутации гейтятся слоем
    разрешений и `--dry-run`, а вот тихо испортить чужие часы — реальный риск.
    """
    if force or log.user_id is None:
        return
    me = _my_user_id(client)
    if log.user_id != me:
        die(
            f"{COMMAND_NAME} time {sub}: запись {log.id} принадлежит другому пользователю "
            f"(user_id={log.user_id}, я {me}); повтори с --force"
        )


# ── Команды: таймер ────────────────────────────────────────────────────────────
#
# Живой таймер виден ТОЛЬКО через `GET /cards/{id}` (поле `timer`): глобального списка
# таймеров у Kaiten нет (`GET /user-timers` → 405, `/current` → 404). Поэтому «мой таймер
# где-то идёт» знает лишь локальная подсказка — и каждый раз сверяется с сервером.


def _running_timer(client: KaitenClient, card_id: int) -> KaitenTimer | None:
    """Запущенный таймер карточки по свежему GET (источник правды)."""
    return client.get_card(card_id).timer


def _verified_running_elsewhere(
    client: KaitenClient, card_id: int
) -> tuple[int, KaitenTimer] | None:
    """Подсказка о таймере на ДРУГОЙ карточке, подтверждённая сервером.

    Протухшую подсказку (сервер говорит «таймера нет») молча чистим и идём дальше —
    блокировать работу по неподтверждённому локальному состоянию нельзя.
    """
    with store.store() as conn:
        store.bootstrap(conn)
        hints = kaiten_links.list_time_hints(conn, running_only=True)
    for hint in hints:
        if hint.card_id == card_id:
            continue
        try:
            timer = _running_timer(client, hint.card_id)
        except KaitenAPIError:
            continue  # карточка недоступна — не повод блокировать старт
        if timer is not None:
            return hint.card_id, timer
        with store.store() as conn:
            kaiten_links.clear_time_hint(conn, hint.card_id, timer_only=True)
    return None


def _msk_hhmm(iso: str | None) -> str:
    """Метка времени → `ЧЧ:ММ МСК` для человекочитаемых строк."""
    if not iso:
        return "?"
    return parse_timestamp(iso).astimezone(MSK).strftime("%H:%M МСК")


@time_app.command("start")
def time_start(
    selector: CardArg,
    role: Annotated[
        str | None, typer.Option("--role", help=_ROLE_HELP, autocompletion=_complete_role)
    ] = None,
    comment: Annotated[
        str, typer.Option("--comment", "-m", help="Над чем работаем (можно уточнить при stop)")
    ] = "",
    force: Annotated[
        bool, typer.Option("--force", help="Запустить, даже если таймер идёт на другой карточке")
    ] = False,
) -> None:
    """Запустить таймер на карточке.

    `--role` запоминается ЛОКАЛЬНО и подставляется при `stop`: API таймера роль не хранит
    (принимает молча и теряет), а выбрать тип работы удобно сразу. Явный `--role` у `stop`
    всё равно перебивает запомненное.

    Перед стартом проверяем, не идёт ли таймер уже — на этой карточке или (по локальной
    подсказке, подтверждённой сервером) на другой: два параллельных таймера дают мусорную
    длительность у того, о котором забыли.
    """
    card_id = _parse_card_ref(selector)
    role_id = _resolve_role(role)
    client = KaitenClient.from_env()
    url = card_url(client.base_url, card_id)
    try:
        running = _running_timer(client, card_id)
        if running is not None:
            die(
                f"{COMMAND_NAME} time start: таймер на карточке {card_id} уже запущен "
                f"(с {_msk_hhmm(running.started_at)}); останови `{COMMAND_NAME} time stop "
                f"{card_id}` или сбрось `{COMMAND_NAME} time discard {card_id}`"
            )
        if not force and (elsewhere := _verified_running_elsewhere(client, card_id)) is not None:
            other_id, other = elsewhere
            die(
                f"{COMMAND_NAME} time start: таймер уже идёт на карточке {other_id} "
                f"(с {_msk_hhmm(other.started_at)}); останови `{COMMAND_NAME} time stop "
                f"{other_id}` или запусти второй через --force"
            )
        started = client.start_timer(card_id, comment=comment)
        if started is None:
            die(
                f"{COMMAND_NAME} time start: Kaiten сообщает, что таймер на карточке "
                f"{card_id} уже создан; останови `{COMMAND_NAME} time stop {card_id}`"
            )
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} time start: kaiten error: {e}")
    _touch_hint(
        card_id,
        timer_id=started.id,
        role_id=role_id,
        comment=comment or None,
        started_at=started.started_at,
    )
    typer.echo(f"ok: таймер запущен {_msk_hhmm(started.started_at)} · {role_name(role_id)} · {url}")


@time_app.command("status")
def time_status(
    selector: CardArgOpt = None,
    out_json: JsonOpt = False,
) -> None:
    """Идёт ли таймер и сколько всего списано по карточке.

    Без селектора — карточка берётся из локальной подсказки (таймер, запущенный этим CLI)
    и сверяется с сервером. Это запрос, а не действие: отсутствие таймера — не ошибка.
    """
    client = KaitenClient.from_env()
    card_id = _parse_card_ref(selector) if selector is not None else _hinted_running_card()
    if card_id is None:
        if out_json:
            print_json({"card_id": None, "timer": None})
            return
        typer.echo("таймер: не знаю ни об одном запущенном (подскажи карточку)")
        return

    try:
        card = client.get_card(card_id)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} time status: kaiten error: {e}")
    timer = card.timer
    if timer is None:
        with store.store() as conn:
            store.bootstrap(conn)
            kaiten_links.clear_time_hint(conn, card_id, timer_only=True)
    running = elapsed_minutes(timer.started_at, _now()) if timer and timer.started_at else None

    if out_json:
        print_json(
            {
                "card_id": card_id,
                "timer": None
                if timer is None
                else {
                    "id": timer.id,
                    "started_at": timer.started_at,
                    "elapsed_minutes": running,
                    "comment": timer.comment,
                },
                "total_minutes": card.time_spent_sum,
            }
        )
        return
    if timer is None:
        typer.echo("таймер: не запущен")
    else:
        note = f" · «{timer.comment}»" if timer.comment else ""
        typer.echo(
            f"таймер: идёт {format_minutes(running or 0)} (с {_msk_hhmm(timer.started_at)}){note}"
        )
    typer.echo(f"всего по карточке: {format_minutes(card.time_spent_sum or 0)}")


def _hinted_running_card() -> int | None:
    """Карточка с запущенным (по мнению CLI) таймером — из локальных подсказок."""
    with store.store() as conn:
        store.bootstrap(conn)
        hints = kaiten_links.list_time_hints(conn, running_only=True)
    return hints[0].card_id if hints else None


def _now() -> datetime.datetime:
    """Текущий момент (aware, UTC). Отдельная функция — шов для тестов."""
    return datetime.datetime.now(datetime.UTC)


def _stop_role_id(role: str | None, hint: kaiten_links.TimeHint | None) -> int:
    """Роль записи: явный `--role` > запомненная при `start` > дефолтная."""
    if role is not None:
        return _resolve_role(role)
    if hint is not None and hint.role_id is not None:
        return hint.role_id
    return _resolve_role(None)


def _render_stop_result(
    created: KaitenTimeLog | None,
    *,
    log_id: int | None,
    actual: int,
    minutes: int | None,
    url: str,
) -> str:
    """Строка итога. Печатаем перечитанную запись, а не свои вычисления: `for_date` сервер
    берёт от `finished_at` в UTC, и остановка ночью по МСК ложится на предыдущий день."""
    if created is None:
        return f"ok: таймер остановлен · запись {log_id} · {url}"
    suffix = (
        f" (по факту {format_minutes(actual)})" if minutes is not None and minutes != actual else ""
    )
    return (
        f"ok: таймер остановлен · записано {format_minutes(created.time_spent)}{suffix} · "
        f"{created.for_date} · {_role_label(created)} · запись {created.id} · {url}"
    )


@time_app.command("stop")
def time_stop(
    selector: CardArg,
    duration: Annotated[
        str | None,
        typer.Option(
            "--time",
            help="Записать эту длительность вместо фактической (1h15m | 1:15 | 90 | 2.5h)",
        ),
    ] = None,
    role: Annotated[
        str | None, typer.Option("--role", help=_ROLE_HELP, autocompletion=_complete_role)
    ] = None,
    comment: Annotated[
        str | None,
        typer.Option("--comment", "-m", help="Что сделано (перебьёт заданное при start)"),
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Показать намеченное, ничего не записывая")
    ] = False,
) -> None:
    """Остановить таймер и записать время.

    Без `--time` пишется фактически натикавшее (длительность считает сервер, округляя вверх
    до минуты). С `--time` метки сдвигаются так же, как это делает поле «Время (чч:мм)» в
    веб-интерфейсе, — см. `timer_window`.

    Созданная запись ПЕРЕЧИТЫВАЕТСЯ и печатается по факту, а не по нашим вычислениям: дату
    записи (`for_date`) сервер берёт от `finished_at` В UTC, поэтому остановка между 00:00 и
    03:00 МСК ложится на предыдущий день — это видно в выводе, а не всплывает потом.
    """
    card_id = _parse_card_ref(selector)
    minutes = _parse_duration("--time", duration) if duration is not None else None
    client = KaitenClient.from_env()
    url = card_url(client.base_url, card_id)
    role_id = _stop_role_id(role, _hint_for(card_id))
    try:
        timer = _running_timer(client, card_id)
        if timer is None or timer.started_at is None:
            die(
                f"{COMMAND_NAME} time stop: таймер на карточке {card_id} не запущен; "
                f"запустить — `{COMMAND_NAME} time start {card_id}`"
            )
        actual = elapsed_minutes(timer.started_at, _now())
        if minutes is not None and minutes > actual:
            typer.echo(
                f"внимание: --time {format_minutes(minutes)} больше фактических "
                f"{format_minutes(actual)} — начало сдвинуто назад",
                err=True,
            )
        start_at, finish_at = timer_window(timer.started_at, _now(), minutes)
        if dry_run:
            planned = format_minutes(minutes if minutes is not None else actual)
            typer.echo(f"dry-run: остановить таймер · {planned} · {role_name(role_id)} · {url}")
            return
        stopped = client.stop_timer(
            timer.id,
            finished_at=finish_at,
            started_at=start_at,
            comment=_stop_comment(comment, timer),
            role_id=role_id,
        )
        created = _read_back(client, card_id, stopped.card_time_log_id)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} time stop: kaiten error: {e}")
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.clear_time_hint(conn, card_id, timer_only=True)

    typer.echo(
        _render_stop_result(
            created, log_id=stopped.card_time_log_id, actual=actual, minutes=minutes, url=url
        )
    )
    if created is not None:
        _warn_if_date_shifted(created.for_date, finish_at)


def _stop_comment(explicit: str | None, timer: KaitenTimer) -> str | None:
    """Комментарий создаваемой записи: явный `-m`, иначе описание, заданное при `start`.

    Подставлять описание таймера обязательно: комментарий записи сервер берёт из тела PATCH,
    а НЕ из самого таймера — не пошлёшь, и текст, набранный при запуске, молча пропадёт
    (веб-интерфейс поэтому и подставляет его в диалог остановки).
    """
    if explicit is not None:
        return explicit
    return timer.comment or None


def _hint_for(card_id: int) -> kaiten_links.TimeHint | None:
    with store.store() as conn:
        store.bootstrap(conn)
        return kaiten_links.get_time_hint(conn, card_id)


def _read_back(client: KaitenClient, card_id: int, log_id: int | None) -> KaitenTimeLog | None:
    """Перечитать созданную остановкой запись — печатаем факт сервера, а не свой расчёт."""
    if log_id is None:
        return None
    return _find_log(client.list_time_logs(card_id), log_id)


def _warn_if_date_shifted(for_date: str, finished_at: str) -> None:
    """Предупредить, если запись легла не на тот день, который человек считает сегодняшним.

    `for_date` сервер берёт от `finished_at` в UTC, а «сегодня» у нас московское — между
    00:00 и 03:00 МСК они расходятся на день.
    """
    msk_day = parse_timestamp(finished_at).astimezone(MSK).date().isoformat()
    if for_date != msk_day:
        typer.echo(
            f"внимание: запись легла на {for_date} (Kaiten берёт дату по UTC), "
            f"а по Москве это уже {msk_day} — поправить: "
            f"`{COMMAND_NAME} time edit <карточка> <id> --date {msk_day}`",
            err=True,
        )


@time_app.command("discard")
def time_discard(
    selector: CardArg,
) -> None:
    """Сбросить таймер, НЕ создавая запись учёта времени.

    Идемпотентно: таймера нет — это успех, а не ошибка («убедиться, что таймер не идёт»).
    Асимметрия со `stop` намеренная: там тихий успех означал бы потерянную работу.
    """
    card_id = _parse_card_ref(selector)
    client = KaitenClient.from_env()
    url = card_url(client.base_url, card_id)
    try:
        timer = _running_timer(client, card_id)
        if timer is None:
            with store.store() as conn:
                store.bootstrap(conn)
                kaiten_links.clear_time_hint(conn, card_id, timer_only=True)
            typer.echo(f"ok: таймера нет — нечего сбрасывать · {url}")
            return
        ran = elapsed_minutes(timer.started_at, _now()) if timer.started_at else 0
        client.discard_timer(timer.id)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} time discard: kaiten error: {e}")
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.clear_time_hint(conn, card_id, timer_only=True)
    typer.echo(f"ok: таймер сброшен без записи (шёл {format_minutes(ran)}) · {url}")


def stop_running_timer(
    client: KaitenClient,
    card: KaitenCardDetail,
    *,
    minutes: int | None = None,
    role_id: int,
    comment: str | None = None,
) -> KaitenTimeLog | None:
    """Остановить таймер уже загруженной карточки; None — если он не запущен.

    Общая для `time stop` и `mpu kiten close`: карточка передаётся готовой, чтобы `close`
    (он и так делает `get_card`) не платил лишним запросом.
    """
    timer = card.timer
    if timer is None or timer.started_at is None:
        return None
    start_at, finish_at = timer_window(timer.started_at, _now(), minutes)
    stopped = client.stop_timer(
        timer.id,
        finished_at=finish_at,
        started_at=start_at,
        comment=_stop_comment(comment, timer),
        role_id=role_id,
    )
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.clear_time_hint(conn, card.id, timer_only=True)
    return _read_back(client, card.id, stopped.card_time_log_id)
