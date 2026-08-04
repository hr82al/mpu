"""`mpu manifest` — машинный слепок дерева команд для внешнего потребителя.

Печатает JSON: по записи на каждый узел дерева — и на листовую команду, и на
составное имя — путь, однострока, справка и описание параметров. Узел с
подкомандами помечен `group`. Нужен реализации CLI на другом языке, чтобы строить
поверхность инструментов, не дублируя объявления руками и не расходясь с этим
деревом при каждом изменении.

Команда намеренно не попадает в `list_commands` (см. `_LazyGroup` в `cli.py`):
её появление в `mpu --help`, `mpu help` и completion изменило бы наблюдаемую
поверхность CLI ради служебной надобности.

Схема параметров здесь НЕ строится: слепок отдаёт click-описание как есть, а
превращение его в JSON Schema — забота потребителя, у которого свои правила
обязательности и значений по умолчанию.
"""

import json
from collections.abc import Sequence
from typing import Any

import click
import typer

COMMAND_NAME = "mpu manifest"
COMMAND_SUMMARY = "Машинный слепок дерева команд (JSON)"

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)

# Версия формата слепка. Растёт при несовместимом изменении структуры — потребитель
# обязан отказаться разбирать незнакомую версию, а не угадывать.
MANIFEST_VERSION = 2

_TYPE_NAMES: dict[type[click.ParamType], str] = {
    click.types.StringParamType: "string",
    click.types.IntParamType: "integer",
    click.types.FloatParamType: "number",
    click.types.BoolParamType: "boolean",
}


def _type_name(param_type: click.ParamType) -> str:
    """Имя типа параметра. Незнакомый тип — строка: click отдаёт его текстом."""
    if isinstance(param_type, click.Choice):
        return "string"
    for cls, name in _TYPE_NAMES.items():
        if isinstance(param_type, cls):
            return name
    return "string"


def _is_json_safe(value: object) -> bool:
    """Значение переживёт сериализацию. Typer кладёт в дефолты свои sentinel-объекты,
    а `json.dumps` о них не знает — проверяем фактом, а не перечислением типов."""
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return False
    return True


def _describe_param(param: click.Parameter) -> dict[str, Any] | None:
    """Описание одного параметра; `--help` пропускается — он не часть контракта."""
    if param.name is None or param.name == "help":
        return None
    described: dict[str, Any] = {
        "name": param.name,
        "kind": "argument" if isinstance(param, click.Argument) else "option",
        "type": _type_name(param.type),
        "required": bool(param.required),
    }
    if isinstance(param, click.Option):
        described["opts"] = list(param.opts)
        if param.secondary_opts:
            described["negatedOpts"] = list(param.secondary_opts)
        if param.multiple:
            described["multiple"] = True
    if param.nargs != 1:
        described["nargs"] = param.nargs
    # Проба атрибута вместо isinstance-сужения: click.Choice — дженерик, стабы не
    # раскрывают тип элементов, и любое сужение к нему делает выражение частично
    # неизвестным для строгого тайпчека. В CLI варианты всегда строки.
    raw_choices: Sequence[object] = getattr(param.type, "choices", ())
    if raw_choices:
        described["choices"] = [str(choice) for choice in raw_choices]
    if param.default is not None and not callable(param.default) and _is_json_safe(param.default):
        described["default"] = param.default
    help_text = getattr(param, "help", None)
    if help_text:
        described["help"] = help_text
    return described


def _describe_command(
    path: list[str], command: click.Command, *, group: bool = False
) -> dict[str, Any]:
    """Описание узла дерева: путь без `mpu`, тексты справки, параметры."""
    params = [d for d in (_describe_param(p) for p in command.params) if d is not None]
    described: dict[str, Any] = {"path": path[1:], "params": params}
    summary = command.get_short_help_str(limit=200)
    if summary:
        described["summary"] = summary
    if command.help:
        described["help"] = command.help
    if command.hidden:
        described["hidden"] = True
    if group:
        described["group"] = True
    return described


def _walk(command: click.Command, path: list[str], ctx: click.Context) -> list[dict[str, Any]]:
    """Обход дерева вглубь: и составные имена, и листья.

    Составное имя несёт собственные однострокѝ и справку (docstring группы), а
    потребителю они нужны для справочных поверхностей и дополнения. Корень `mpu`
    записью не является: его путь пуст, а описание CLI — не команда дерева.
    """
    if not isinstance(command, click.Group):
        return [_describe_command(path, command)]
    nodes: list[dict[str, Any]] = []
    if len(path) > 1:
        nodes.append(_describe_command(path, command, group=True))
    for name in command.list_commands(ctx):
        child = command.get_command(ctx, name)
        if child is None:
            continue
        child_ctx = click.Context(child, info_name=name, parent=ctx)
        nodes.extend(_walk(child, [*path, name], child_ctx))
    return nodes


def build_manifest() -> dict[str, Any]:
    """Собирает слепок всего дерева. Импортирует все модули команд — цена ~секунда."""
    from mpu import __version__
    from mpu.cli import app as root_app

    root = typer.main.get_command(root_app)
    ctx = click.Context(root, info_name="mpu")
    return {
        "manifestVersion": MANIFEST_VERSION,
        "mpuVersion": __version__,
        "commands": _walk(root, ["mpu"], ctx),
    }


@app.command()
def main() -> None:
    """Печатает JSON-слепок дерева команд в stdout."""
    typer.echo(json.dumps(build_manifest(), ensure_ascii=False, indent=2))
