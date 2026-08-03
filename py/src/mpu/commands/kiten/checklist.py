"""`mpu kiten checklist` — чек-листы карточки (интерактивные чекбоксы Kaiten).

`ls` — read-only; `add`/`check`/`uncheck` — мутации. Чек-лист — ЕДИНСТВЕННЫЙ способ
получить кликабельные чекбоксы в Kaiten: `- [ ]` в описании карточки рендерится
обычным текстом (см. `mpu kiten desc --help`).
"""

from __future__ import annotations

import json as _json
from dataclasses import dataclass
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from mpu.commands.kiten._app import app
from mpu.commands.kiten._common import COMMAND_NAME, CardArg, JsonOpt, _parse_card_ref
from mpu.lib.cli_err import die
from mpu.lib.kaiten import (
    KaitenAPIError,
    KaitenChecklist,
    KaitenChecklistItem,
    KaitenClient,
    card_url,
)

__all__ = ["ItemRef", "ordered_items", "resolve_checklist_item"]

checklist_app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=(
        "Чек-листы карточки — единственные ИНТЕРАКТИВНЫЕ чекбоксы Kaiten (`- [ ]` в "
        "описании рендерится текстом). `ls` — чек-листы с пунктами (read-only); "
        "`add` — создать чек-лист и/или добавить пункты; `check`/`uncheck` — отметить/"
        "снять пункт (по id или уникальной подстроке текста)."
    ),
)
app.add_typer(checklist_app, name="checklist")


@dataclass(frozen=True)
class ItemRef:
    """Резолвнутый пункт: сам пункт + чек-лист, в котором он лежит (нужен для PATCH)."""

    checklist: KaitenChecklist
    item: KaitenChecklistItem


def resolve_checklist_item(checklists: list[KaitenChecklist], ref: str) -> ItemRef:
    """Пункт чек-листа по `ref`: сначала точный id, затем подстрока текста (без регистра).

    Чистая функция (без I/O). Числовой `ref`, совпавший с id пункта, побеждает всегда;
    иначе — подстрочный поиск по тексту всех пунктов всех чек-листов карточки.
    Не найден или неоднозначен → ValueError с перечнем кандидатов (id: текст).
    """
    pairs = [ItemRef(cl, item) for cl in checklists for item in cl.items]
    needle = ref.strip()
    if needle.isdigit():
        by_id = [p for p in pairs if p.item.id == int(needle)]
        if by_id:
            return by_id[0]
    matches = [p for p in pairs if needle.casefold() in p.item.text.casefold()]
    if len(matches) == 1:
        return matches[0]
    listing = "; ".join(f"{p.item.id}: {p.item.text[:60]}" for p in (matches or pairs))
    if not matches:
        raise ValueError(f"пункт {ref!r} не найден; есть: {listing or '(пунктов нет)'}")
    raise ValueError(f"пункт {ref!r} неоднозначен, кандидаты: {listing}")


def _mark(item: KaitenChecklistItem) -> str:
    return "[x]" if item.checked else "[ ]"


def ordered_items(items: list[KaitenChecklistItem]) -> list[KaitenChecklistItem]:
    """Пункты в порядке карточки — по `sort_order`, при равенстве по id.

    API отдаёт `items` в произвольном порядке (наблюдалось: отмеченный первый пункт
    приезжает четвёртым), а человек сверяет вывод с карточкой глазами — сортировка
    обязательна, иначе `ls` и веб-карточка выглядят разными списками.
    """
    return sorted(items, key=lambda i: (i.sort_order if i.sort_order is not None else 0.0, i.id))


@checklist_app.command("ls")
def checklist_ls(selector: CardArg, out_json: JsonOpt = False) -> None:
    """Чек-листы карточки с пунктами (read-only): id, отметка, текст.

    `id` пункта из этого вывода принимают `check`/`uncheck` (можно и подстроку текста).
    """
    card_id = _parse_card_ref(selector)
    client = KaitenClient.from_env()
    try:
        card = client.get_card(card_id)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} checklist ls: kaiten error: {e}")
    if out_json:
        payload = [
            {
                "id": cl.id,
                "name": cl.name,
                "items": [
                    {"id": i.id, "checked": i.checked, "text": i.text}
                    for i in ordered_items(cl.items)
                ],
            }
            for cl in card.checklists
        ]
        typer.echo(_json.dumps(payload, ensure_ascii=False))
        return
    if not card.checklists:
        typer.echo("(чек-листов нет)")
        return
    # markup=False обязателен: иначе rich считает `[x]` тегом разметки и съедает отметку;
    # highlight=False — чтобы id/счётчики не раскрашивались (вывод часто уходит в пайп).
    console = Console(markup=False, highlight=False)
    for cl in card.checklists:
        done = sum(1 for i in cl.items if i.checked)
        console.print(f"{cl.name} · {done}/{len(cl.items)} (checklist id {cl.id})")
        table = Table(box=None)
        for col in ("id", "✓", "text"):
            table.add_column(col)
        for item in ordered_items(cl.items):
            table.add_row(str(item.id), _mark(item), item.text)
        console.print(table)


@checklist_app.command("add")
def checklist_add(
    selector: CardArg,
    name: Annotated[
        str, typer.Option("--name", "-n", help="Название чек-листа (например «Подзадачи»)")
    ],
    items: Annotated[
        list[str] | None,
        typer.Option(
            "--item",
            "-i",
            help="Текст пункта; флаг повторяемый — пункты добавляются в заданном порядке",
        ),
    ] = None,
) -> None:
    """Создать чек-лист карточки и/или добавить пункты (интерактивные чекбоксы).

    Идемпотентно по названию: чек-лист с таким `--name` уже есть → новый НЕ создаётся,
    пункты `--item` дописываются в конец существующего (уже существующие тексты
    пропускаются — повторный запуск не плодит дубли). Отметить пункт выполненным —
    `mpu kiten checklist check`.
    """
    card_id = _parse_card_ref(selector)
    client = KaitenClient.from_env()
    try:
        card = client.get_card(card_id)
        existing = next((cl for cl in card.checklists if cl.name == name), None)
        checklist = existing if existing is not None else client.add_checklist(card_id, name)
        have = {i.text for i in checklist.items}
        base = max((i.sort_order or 0.0 for i in checklist.items), default=0.0)
        added = 0
        for n, text in enumerate(items or [], start=1):
            if text in have:
                continue
            client.add_checklist_item(card_id, checklist.id, text, sort_order=base + n)
            added += 1
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} checklist add: kaiten error: {e}")
    state = "существующий" if existing is not None else "создан"
    typer.echo(
        f"ok: чек-лист «{name}» ({state}, id {checklist.id}), добавлено пунктов: {added}"
        f" · {card_url(client.base_url, card_id)}"
    )


def _set_checked(selector: str, item_ref: str, *, checked: bool, verb: str) -> None:
    """Общее тело `check`/`uncheck`: резолв пункта по карточке + PATCH checked."""
    card_id = _parse_card_ref(selector)
    client = KaitenClient.from_env()
    try:
        card = client.get_card(card_id)
        try:
            ref = resolve_checklist_item(card.checklists, item_ref)
        except ValueError as e:
            die(f"{COMMAND_NAME} checklist {verb}: {e}")
        client.set_checklist_item_checked(card_id, ref.checklist.id, ref.item.id, checked)
    except KaitenAPIError as e:
        die(f"{COMMAND_NAME} checklist {verb}: kaiten error: {e}")
    mark = "[x]" if checked else "[ ]"
    typer.echo(f"ok: {mark} {ref.item.text} · {card_url(client.base_url, card_id)}")


_ITEM_HELP = (
    "Пункт: id (см. `checklist ls`) или уникальная подстрока текста; "
    "число сначала пробуется как id, и только потом как подстрока"
)


@checklist_app.command("check")
def checklist_check(
    selector: CardArg, item: Annotated[str, typer.Argument(help=_ITEM_HELP)]
) -> None:
    """Отметить пункт чек-листа выполненным (идемпотентно)."""
    _set_checked(selector, item, checked=True, verb="check")


@checklist_app.command("uncheck")
def checklist_uncheck(
    selector: CardArg, item: Annotated[str, typer.Argument(help=_ITEM_HELP)]
) -> None:
    """Снять отметку выполнения с пункта чек-листа (идемпотентно)."""
    _set_checked(selector, item, checked=False, verb="uncheck")
