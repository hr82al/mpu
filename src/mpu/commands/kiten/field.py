"""`mpu kiten field` — кастомные поля карточки (MR / гипотеза / что сделано / результат)
+ лог в SQLite: `set`/`update`/`rm` мутируют, `ls` — read-only."""

from __future__ import annotations

import datetime
import json as _json
import sqlite3
from enum import StrEnum
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import COMMAND_NAME, _parse_card_ref
from mpu.lib import kaiten_links, store
from mpu.lib.cli_err import die
from mpu.lib.kaiten import KaitenAPIError, KaitenClient, card_url

# `_sync_card_field` — `_`-имя, общее для `move.close`; `__all__` помечает намеренный
# package-internal экспорт (снимает reportPrivateUsage).
__all__ = ["_sync_card_field"]

# --- field: кастомные поля карточки (MR-ссылка / гипотеза / что сделано / результат) ---
#
# `set`/`update`/`rm` — мутирующие (PATCH /cards + запись в SQLite-лог); `ls` — read-only
# (только лог). Поле карточки всегда = последняя по времени запись лога для (card, field);
# история (несколько MR на карточку) живёт в `kaiten_card_links`.


class FieldKind(StrEnum):
    mr = "mr"
    hypothesis = "hypothesis"
    done = "done"
    result = "result"


field_app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=(
        "Кастомные поля карточки + лог в SQLite: `set` — записать значение в поле "
        "(mr/hypothesis/done/result) и в историю; `ls` — история (read-only); "
        "`update`/`rm` — правка/удаление записи лога. Несколько записей на карточку "
        "(напр. несколько MR); поле карточки = последняя по времени запись."
    ),
)
app.add_typer(field_app, name="field")


def _sync_card_field(
    conn: sqlite3.Connection, client: KaitenClient, card_id: int, field: str
) -> str | None:
    """Поле карточки := последняя запись лога (или очистка). Возвращает применённое значение."""
    value = kaiten_links.latest_value(conn, card_id, field)
    client.set_card_property(card_id, kaiten_links.property_key(field), value)
    return value


@field_app.command("set")
def field_set(
    selector: Annotated[
        str, typer.Argument(help="ID карточки или URL btlz.kaiten.ru (короткий/глубокий)")
    ],
    kind: Annotated[FieldKind, typer.Argument(help="Поле: mr / hypothesis / done / result")],
    value: Annotated[str, typer.Argument(help="Значение (для mr — URL мерж-реквеста)")],
) -> None:
    """Записать значение в кастомное поле карточки и добавить запись в историю (лог).

    Поле карточки становится этим значением (последняя запись лога). Для `mr` можно
    вызывать несколько раз — каждый запуск добавляет MR в историю; в поле карточки
    «Ссылка на Merge Request» остаётся последний.
    """
    card_id = _parse_card_ref(selector)
    client = KaitenClient.from_env()
    with store.store() as conn:
        store.bootstrap(conn)
        kaiten_links.record_link(conn, card_id, kind.value, value)
        try:
            applied = _sync_card_field(conn, client, card_id, kind.value)
        except KaitenAPIError as e:
            die(f"{COMMAND_NAME} field set: kaiten error: {e}")
    typer.echo(f"ok: {kind.value} → {applied} · {card_url(client.base_url, card_id)}")


@field_app.command("ls")
def field_ls(
    card: Annotated[
        str | None,
        typer.Option("--card", help="Фильтр по карточке (ID или URL)"),
    ] = None,
    kind: Annotated[
        FieldKind | None,
        typer.Option("--kind", help="Фильтр по полю: mr / hypothesis / done / result"),
    ] = None,
    out_json: Annotated[bool, typer.Option("--json", help="JSON-вывод вместо таблицы")] = False,
) -> None:
    """История привязок (read-only): id, карточка, поле, значение, время."""
    card_id: int | None = None
    if card is not None:
        card_id = _parse_card_ref(card)
    with store.store() as conn:
        store.bootstrap(conn)
        links = kaiten_links.list_links(
            conn, card_id=card_id, field=None if kind is None else kind.value
        )
    if out_json:
        payload = [
            {
                "id": link.id,
                "card_id": link.card_id,
                "field": link.field,
                "value": link.value,
                "created_at": link.created_at,
            }
            for link in links
        ]
        typer.echo(_json.dumps(payload, ensure_ascii=False))
        return
    if not links:
        typer.echo("(пусто)")
        return
    table = Table(box=None)
    for col in ("id", "card", "field", "when", "value"):
        table.add_column(col)
    for link in links:
        when = datetime.datetime.fromtimestamp(link.created_at, tz=datetime.UTC).strftime(
            "%Y-%m-%d %H:%M"
        )
        table.add_row(str(link.id), str(link.card_id), link.field, when, link.value)
    Console().print(table)


@field_app.command("update")
def field_update(
    record_id: Annotated[int, typer.Argument(help="ID записи лога (см. `mpu kiten field ls`)")],
    value: Annotated[str, typer.Argument(help="Новое значение")],
) -> None:
    """Изменить значение записи лога и пере-синхронизировать поле карточки."""
    client = KaitenClient.from_env()
    with store.store() as conn:
        store.bootstrap(conn)
        link = kaiten_links.update_link(conn, record_id, value)
        if link is None:
            die(f"{COMMAND_NAME} field update: записи #{record_id} нет")
        try:
            applied = _sync_card_field(conn, client, link.card_id, link.field)
        except KaitenAPIError as e:
            die(f"{COMMAND_NAME} field update: kaiten error: {e}")
    url = card_url(client.base_url, link.card_id)
    typer.echo(f"ok: #{record_id} {link.field} → {applied} · {url}")


@field_app.command("rm")
def field_rm(
    record_id: Annotated[int, typer.Argument(help="ID записи лога (см. `mpu kiten field ls`)")],
) -> None:
    """Удалить запись лога и пере-синхронизировать поле карточки (на предыдущую запись/очистку)."""
    client = KaitenClient.from_env()
    with store.store() as conn:
        store.bootstrap(conn)
        link = kaiten_links.delete_link(conn, record_id)
        if link is None:
            die(f"{COMMAND_NAME} field rm: записи #{record_id} нет")
        try:
            applied = _sync_card_field(conn, client, link.card_id, link.field)
        except KaitenAPIError as e:
            die(f"{COMMAND_NAME} field rm: kaiten error: {e}")
    tail = "(очищено)" if applied is None else f"→ {applied}"
    url = card_url(client.base_url, link.card_id)
    typer.echo(f"ok: удалена #{record_id} {link.field} {tail} · {url}")
