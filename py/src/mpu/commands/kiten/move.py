"""`mpu kiten move`/`ready`/`review`/`close` — перемещение карточки (+ лог в журнал)
и закрытие (обязательные поля + ответ + перенос в «Готово»)."""

from __future__ import annotations

import datetime
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import (
    COMMAND_NAME,
    CardArg,
    _complete_board,
    _complete_column,
    _complete_lane,
    _parse_card_ref,
    _resolve_board,
    _resolve_column,
    _resolve_lane,
    _resolve_role,
)
from mpu.commands.kiten.comment import ALL_MENTION_RE, _expand_all_to_owner, plan_field_actions
from mpu.commands.kiten.field import _sync_card_field
from mpu.commands.kiten.timelog import elapsed_minutes, parse_timestamp, stop_running_timer
from mpu.lib import env, kaiten_links, store
from mpu.lib.cli_err import die
from mpu.lib.duration import format_minutes
from mpu.lib.kaiten import KaitenAPIError, KaitenClient
from mpu.lib.kiten_status import MSK

if TYPE_CHECKING:
    # Только аннотации: runtime-импорт моделей тянет pydantic (~150 мс) в startup.
    from mpu.lib.kaiten_models import KaitenCardDetail, KaitenTimeLog

# `_left_neighbor_column` — `_`-имя, реэкспортируется пакетом для тестов; `__all__`
# помечает его как намеренный package-internal экспорт (снимает reportPrivateUsage).
__all__ = ["_left_neighbor_column"]


@app.command("move")
def move(
    selector: CardArg,
    lane: Annotated[
        str | None,
        typer.Option(
            "--lane",
            help="Дорожка назначения: ID или подстрока названия (см. `mpu kiten lanes`)",
            autocompletion=_complete_lane,
        ),
    ] = None,
    column: Annotated[
        str | None,
        typer.Option(
            "--column",
            help="Колонка назначения: ID или подстрока названия (см. `mpu kiten columns`)",
            autocompletion=_complete_column,
        ),
    ] = None,
    board: Annotated[
        str | None,
        typer.Option(
            "--board",
            help="Доска назначения: ID/подстрока (перенос на другую доску; `mpu kiten boards`)",
            autocompletion=_complete_board,
        ),
    ] = None,
) -> None:
    """Переместить карточку: по дорожке (`--lane`), колонке (`--column`) и/или доске (`--board`).

    Нужна хотя бы одна ось. Подстроки `--lane`/`--column` резолвятся в скоупе целевой доски
    (`--board`, иначе текущая доска карточки), чтобы одноимённые дорожки/колонки разных досок
    не путались.
    """
    if lane is None and column is None and board is None:
        raise typer.BadParameter("нужно хотя бы одно из --lane / --column / --board")
    card_id = _parse_card_ref(selector)
    cli_board = _resolve_board(board)
    client = KaitenClient.from_env()
    try:
        before = client.get_card(card_id)
        # Скоуп резолва дорожки/колонки — целевая доска: явный --board, иначе текущая карточки.
        scope_board = cli_board if cli_board is not None else before.board_id
        lane_id = _resolve_lane(lane, scope_board)
        column_id = _resolve_column(column, scope_board)
        # Перевод только по колонке, и карточка уже в ней → релог-bump (влево→обратно),
        # чтобы Kaiten записал перемещение (в ту же колонку он его игнорирует).
        relogged = (
            lane_id is None
            and cli_board is None
            and column_id is not None
            and before.column_id == column_id
        )
        if relogged and column_id is not None:
            neighbor_id = _left_neighbor_column(client, before.board_id, column_id)
            client.move_card(card_id, column_id=neighbor_id)
            client.move_card(card_id, column_id=column_id)
        else:
            client.move_card(card_id, lane_id=lane_id, column_id=column_id, board_id=cli_board)
        # PATCH-ответ Kaiten не несёт title'ов колонки/доски/дорожки (только id) → свежий GET.
        after = client.get_card(card_id)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} move: kaiten error: {e}")
    _record_card_move(card_id, before, after)
    suffix = " (релог)" if relogged else ""
    typer.echo(f"ok: {_location_label(before)} → {_location_label(after)}{suffix} · {after.url}")


def _location_label(detail: KaitenCardDetail) -> str:
    """`Доска · Колонка · Дорожка` карточки (непустые части); пусто → «—»."""
    parts = (detail.board_title, detail.column_title, detail.lane_title)
    return " · ".join(x for x in parts if x) or "—"


def _record_card_move(
    card_id: int, before: KaitenCardDetail, after: KaitenCardDetail, *, note: str | None = None
) -> None:
    """Записать перемещение в локальный журнал `kaiten_card_moves` (для `mpu telegram status`)."""
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_move(
            conn,
            card_id,
            to_column=after.column_title or "—",
            title=after.title,
            url=after.url,
            from_column=before.column_title,
            lane=after.lane_title,
            board=after.board_title,
            note=note,
        )


def _left_neighbor_column(client: KaitenClient, board_id: int | None, target_id: int) -> int:
    """Колонка слева от `target_id` (по `sort_order`); если цель крайняя левая — берём правую
    соседку. Нужна для релог-bump: перевести карточку в соседнюю колонку и обратно."""
    cols = client.list_columns([board_id] if board_id is not None else [])
    if not cols:
        raise typer.BadParameter("не удалось получить колонки доски для релога")
    ordered = sorted(cols, key=lambda c: (c.sort_order if c.sort_order is not None else 0.0, c.id))
    ids = [c.id for c in ordered]
    if target_id not in ids:
        raise typer.BadParameter("целевая колонка не найдена на доске карточки")
    i = ids.index(target_id)
    if i > 0:
        return ids[i - 1]
    if len(ids) > 1:
        return ids[i + 1]
    raise typer.BadParameter("на доске одна колонка — релог невозможен")


def _timer_plan(card: KaitenCardDetail, *, stop_timer: bool) -> str:
    """Строка про таймер для плана `close` и для предупреждения без `--stop-timer`.

    Длительность в тексте не косметика: именно она показывает, что таймер забыт со среды,
    и удерживает от «останавливаю не глядя».
    """
    timer = card.timer
    if timer is None:
        return "не запущен"
    since = "?"
    ran = ""
    if timer.started_at:
        started = parse_timestamp(timer.started_at)
        since = started.astimezone(MSK).strftime("%d.%m %H:%M МСК")
        ran = f", {format_minutes(elapsed_minutes(timer.started_at, datetime.datetime.now(MSK)))}"
    if stop_timer:
        return f"остановить (запущен с {since}{ran})"
    return (
        f"на карточке запущен таймер (с {since}{ran}); он НЕ остановлен — "
        f"`{COMMAND_NAME} time stop {card.id}` (или --stop-timer)"
    )


def _move_to_target_column(
    selector: str, target_name: str, *, note: str | None, dry_run: bool
) -> None:
    """Перевести карточку в колонку `target_name` (точное имя в приоритете) на её текущей доске;
    дорожка/доска сохраняются. Если карточка уже в целевой колонке — релог-bump (влево→обратно),
    чтобы Kaiten зафиксировал перемещение как моё сегодня. Логирует в `kaiten_card_moves`."""
    card_id = _parse_card_ref(selector)
    client = KaitenClient.from_env()
    try:
        before = client.get_card(card_id)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME}: kaiten error: {e}")
    target_id = _resolve_column(target_name, before.board_id)
    if target_id is None:  # target_name не None → вернётся int либо BadParameter; защита для типов
        raise typer.BadParameter(f"колонка «{target_name}» не найдена")
    already = before.column_id == target_id
    if dry_run:
        action = "релог (влево→обратно)" if already else "перемещение"
        typer.echo(
            f"dry-run: {action} → «{target_name}» (колонка {target_id}); "
            f"сейчас {_location_label(before)}; PATCH не отправлен"
        )
        return
    try:
        if already:
            neighbor_id = _left_neighbor_column(client, before.board_id, target_id)
            client.move_card(card_id, column_id=neighbor_id)
        client.move_card(card_id, column_id=target_id)
        # PATCH-ответ Kaiten не несёт title'ов колонки/доски (только id) → свежий GET.
        after = client.get_card(card_id)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME}: kaiten error: {e}")
    _record_card_move(card_id, before, after, note=note)
    suffix = " (релог)" if already else ""
    typer.echo(f"ok: {_location_label(before)} → {_location_label(after)}{suffix} · {after.url}")


@app.command("ready")
def ready(
    selector: CardArg,
    column: Annotated[
        str | None,
        typer.Option(
            "--column",
            help="Целевая колонка (ID/имя); по умолчанию env KITEN_READY_COLUMN или «Готово»",
            autocompletion=_complete_column,
        ),
    ] = None,
    note: Annotated[
        str | None, typer.Option("--note", help="Заметка, сохраняется в журнал перемещений")
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Показать намеченное, ничего не записывая")
    ] = False,
) -> None:
    """Перевести карточку в колонку «Готово» (дорожка/доска сохраняются) + лог в журнал.

    Цель — точное имя колонки на текущей доске карточки (env `KITEN_READY_COLUMN`, по
    умолчанию «Готово»; переопределяется `--column`). Если карточка уже в этой колонке —
    делается релог-bump (перевод в соседнюю колонку и обратно), т.к. перевод в ту же колонку
    Kaiten не логирует.
    """
    target = column or env.get("KITEN_READY_COLUMN") or "Готово"
    _move_to_target_column(selector, target, note=note, dry_run=dry_run)


@app.command("review")
def review(
    selector: CardArg,
    column: Annotated[
        str | None,
        typer.Option(
            "--column",
            help="Целевая колонка (ID/имя); по умолчанию env KITEN_REVIEW_COLUMN или «Код-ревью»",
            autocompletion=_complete_column,
        ),
    ] = None,
    note: Annotated[
        str | None, typer.Option("--note", help="Заметка, сохраняется в журнал перемещений")
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Показать намеченное, ничего не записывая")
    ] = False,
) -> None:
    """Перевести карточку в колонку ревью (дорожка/доска сохраняются) + лог в журнал.

    Цель — точное имя колонки на текущей доске (env `KITEN_REVIEW_COLUMN`, по умолчанию
    «Код-ревью»; переопределяется `--column`). Если карточку уже двинул в ревью кто-то другой —
    делается релог-bump (соседняя колонка и обратно), чтобы Kaiten записал это как моё
    перемещение сегодня (перевод в ту же колонку Kaiten не логирует).
    """
    target = column or env.get("KITEN_REVIEW_COLUMN") or "Код-ревью"
    _move_to_target_column(selector, target, note=note, dry_run=dry_run)


@dataclass(frozen=True, slots=True)
class _ClosePlan:
    """Что `close` намерен сделать. Считается без единой записи — из карточки и аргументов."""

    card: KaitenCardDetail
    to_set: list[tuple[str, str]]
    skipped: list[str]
    reply_text: str | None
    mentioned: list[str]
    target_column: str
    timer_note: str
    stop_timer: bool
    no_move: bool
    warnings: list[str]

    @property
    def fields_label(self) -> str:
        return ", ".join(kind for kind, _ in self.to_set) or "—"

    @property
    def skipped_label(self) -> str:
        return f"; пропущены (заполнены) [{', '.join(self.skipped)}]" if self.skipped else ""

    @property
    def mention_label(self) -> str:
        return f" (@all → {' '.join('@' + h for h in self.mentioned)})" if self.mentioned else ""


def _resolve_reply_text(reply: str | None, reply_file: str | None) -> str | None:
    """Текст ответа ровно из одного источника: `--reply`, файл или stdin (`-`)."""
    if reply is not None and reply_file is not None:
        raise typer.BadParameter("--reply и --reply-file взаимоисключающи")
    text = reply
    if reply_file == "-":
        text = sys.stdin.read()
    elif reply_file is not None:
        try:
            text = Path(reply_file).read_text(encoding="utf-8")
        except OSError as e:
            raise typer.BadParameter(f"не удалось прочитать {reply_file}: {e}") from None
    if text is not None and not text.strip():
        raise typer.BadParameter("пустой текст ответа")
    return text


def _plan_close(
    card: KaitenCardDetail,
    *,
    provided: dict[str, str | None],
    force_fields: bool,
    reply_text: str | None,
    column: str | None,
    stop_timer: bool,
    no_move: bool,
) -> _ClosePlan:
    """Карточка + аргументы → план. Без сети и записей: всё, что решается заранее."""
    current = {k: card.properties.get(kaiten_links.property_key(k)) for k in provided}
    to_set, skipped = plan_field_actions(current, provided, force=force_fields)

    mentioned: list[str] = []
    warnings: list[str] = []
    if reply_text is not None:
        had_all = ALL_MENTION_RE.search(reply_text) is not None
        reply_text, mentioned = _expand_all_to_owner(reply_text, card)
        if had_all and not mentioned:
            warnings.append(
                f"{COMMAND_NAME} close: у карточки нет владельца — '@all' оставлен как есть"
            )

    return _ClosePlan(
        card=card,
        to_set=to_set,
        skipped=skipped,
        reply_text=reply_text,
        mentioned=mentioned,
        target_column=column or env.get("KITEN_READY_COLUMN") or "Готово",
        timer_note=_timer_plan(card, stop_timer=stop_timer),
        stop_timer=stop_timer,
        no_move=no_move,
        warnings=warnings,
    )


def _render_close_plan(plan: _ClosePlan) -> list[str]:
    """Строки `--dry-run`: то же намерение, которое выполнит `_apply_close`."""
    reply = "запостить" + plan.mention_label if plan.reply_text is not None else "без ответа"
    lines = [
        f"dry-run close · {plan.card.url}",
        f"  таймер: {plan.timer_note}",
        f"  поля: записать [{plan.fields_label}]{plan.skipped_label}",
        f"  ответ: {reply}",
    ]
    if plan.no_move:
        lines.append("  перенос: пропущен (--no-move)")
    return lines


def _apply_close(client: KaitenClient, plan: _ClosePlan, *, card_id: int, selector: str) -> None:
    """Выполнить план. Порядок: таймер → поля → ответ → перенос.

    Таймер ПЕРВЫМ: время уже отработано, и сбой на ответе клиенту не должен его потерять.
    """
    logged: KaitenTimeLog | None = None
    if plan.stop_timer and plan.card.timer is not None:
        try:
            logged = stop_running_timer(client, plan.card, role_id=_resolve_role(None))
        except KaitenAPIError as e:
            die(f"{COMMAND_NAME} close: kaiten error (таймер): {e}")
    elif plan.card.timer is not None:
        typer.echo(f"внимание: {plan.timer_note}", err=True)

    if plan.to_set:
        with store.store() as conn:
            store.bootstrap(conn)
            try:
                for kind, value in plan.to_set:
                    kaiten_links.record_link(conn, card_id, kind, value)
                    _sync_card_field(conn, client, card_id, kind)
            except KaitenAPIError as e:
                die(f"{COMMAND_NAME} close: kaiten error (поля): {e}")

    reply_comment_id: int | None = None
    if plan.reply_text is not None:
        try:
            reply_comment_id = client.add_comment(card_id, plan.reply_text).id
        except KaitenAPIError as e:
            die(f"{COMMAND_NAME} close: kaiten error (ответ): {e}")

    typer.echo(f"ok close: поля [{plan.fields_label}]{plan.skipped_label}")
    if logged is not None:
        parts = [format_minutes(logged.time_spent), logged.role_name or "", f"запись {logged.id}"]
        typer.echo("   таймер: " + " · ".join(p for p in parts if p))
    if reply_comment_id is not None:
        typer.echo(f"   ответ: комментарий {reply_comment_id}{plan.mention_label}")
    if not plan.no_move:
        _move_to_target_column(selector, plan.target_column, note=None, dry_run=False)


@app.command("close")
def close(  # noqa: PLR0913
    selector: CardArg,
    hypothesis: Annotated[
        str | None, typer.Option("--hypothesis", help="«Причина/гипотеза» (если поле пусто)")
    ] = None,
    done: Annotated[str | None, typer.Option("--done", help="«Что сделано» (если пусто)")] = None,
    result: Annotated[str | None, typer.Option("--result", help="«Результат» (если пусто)")] = None,
    mr: Annotated[str | None, typer.Option("--mr", help="Ссылка на MR (если поле пусто)")] = None,
    reply: Annotated[
        str | None, typer.Option("--reply", help="Ответ клиенту (markdown; `@all`→владелец)")
    ] = None,
    reply_file: Annotated[
        str | None, typer.Option("--reply-file", help="Файл с телом ответа; `-` — stdin")
    ] = None,
    column: Annotated[
        str | None,
        typer.Option(
            "--column",
            help="Колонка переноса (по умолч. KITEN_READY_COLUMN или «Готово»)",
            autocompletion=_complete_column,
        ),
    ] = None,
    force_fields: Annotated[
        bool, typer.Option("--force-fields", help="Перезаписать поля, даже если заполнены")
    ] = False,
    no_move: Annotated[
        bool, typer.Option("--no-move", help="Не переносить карточку (только поля/ответ)")
    ] = False,
    stop_timer: Annotated[
        bool, typer.Option("--stop-timer", help="Остановить запущенный таймер и записать время")
    ] = False,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Показать намеченное, ничего не записывая")
    ] = False,
) -> None:
    """Закрыть карточку: пустые обязательные поля + (опц.) ответ клиенту + перенос в «Готово».

    Детерминированный оркестратор: тексты полей/ответа готовит вызывающий, передаёт аргументами.
    Поля пишутся только если на карточке пусты (вручную/ранее заполненные пропускаются;
    `--force-fields` перезаписывает). `@all` в ответе → `@username` владельца (заказчик). Перенос —
    с релогом, если уже в колонке. Порядок: таймер → поля → ответ → перенос. `--dry-run` — план.

    Таймер останавливается ТОЛЬКО по `--stop-timer`; без флага о запущенном таймере громко
    предупреждаем, но не трогаем его. Создавать запись учёта времени побочным эффектом закрытия
    нельзя: забытый трёхдневный таймер молча превратился бы в запись на 70 часов. Нужна
    конкретная длительность или роль — сперва `mpu kiten time stop`, потом `close` (он тогда
    просто не найдёт таймера). Остановка идёт ПЕРВОЙ: время уже отработано, и сбой на ответе
    клиенту не должен его потерять.
    """
    card_id = _parse_card_ref(selector)
    reply_text = _resolve_reply_text(reply, reply_file)

    client = KaitenClient.from_env()
    try:
        before = client.get_card(card_id)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} close: kaiten error: {e}")

    plan = _plan_close(
        before,
        provided={"hypothesis": hypothesis, "done": done, "result": result, "mr": mr},
        force_fields=force_fields,
        reply_text=reply_text,
        column=column,
        stop_timer=stop_timer,
        no_move=no_move,
    )
    for warning in plan.warnings:
        typer.echo(warning, err=True)

    if dry_run:
        for line in _render_close_plan(plan):
            typer.echo(line)
        if not plan.no_move:
            _move_to_target_column(selector, plan.target_column, note=None, dry_run=True)
        return

    _apply_close(client, plan, card_id=card_id, selector=selector)
