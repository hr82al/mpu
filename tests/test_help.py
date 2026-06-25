"""Tests for mpu help command."""
# pyright: reportPrivateUsage=false
# обоснование: проверяем приватные хелперы реестра — _print_list / _render_help /
# _COMMANDS / _REGISTERED_MODULES, доступ к ним намеренный.

import importlib
import re

import pytest
import typer
from typer.testing import CliRunner

from mpu import cli_registry
from mpu.commands import help as help_mod
from mpu.commands.help import app

runner = CliRunner()


def test_list_no_args() -> None:
    """Вывод списка без аргументов должен содержать все команды."""
    result = runner.invoke(app, [])
    assert result.exit_code == 0
    assert "mpu search" in result.stdout
    assert "mpu update" in result.stdout
    assert "mpu sql" in result.stdout
    assert "mpu backup-wb-unit-proto" in result.stdout
    assert "mpu backup-ozon-unit-proto" in result.stdout
    assert "mpu help" in result.stdout
    assert "Available commands" in result.stdout
    assert "Run `<command> --help`" in result.stdout


def test_unknown_command() -> None:
    """Неизвестная команда должна выдать ошибку."""
    result = runner.invoke(app, ["unknown-cmd"])
    assert result.exit_code == 2
    assert "unknown command 'unknown-cmd'" in result.stderr


def test_h_flag() -> None:
    """-h флаг должен работать как --help."""
    result = runner.invoke(app, ["-h"])
    assert result.exit_code == 0
    assert "Список всех mpu команд" in result.stdout or "Available commands" in result.stdout


def test_help_flag() -> None:
    """--help флаг должен показывать справку."""
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "Usage" in result.stdout or "Список" in result.stdout


def test_renders_target_command_help() -> None:
    """`mpu help mpu search` рендерит --help целевой команды без subprocess."""
    result = runner.invoke(app, ["mpu search"])
    assert result.exit_code == 0
    assert "mpu search" in result.stdout
    # Маркеры из docstring/options самой mpu search:
    assert "client_id" in result.stdout
    assert "--no-update" in result.stdout


# ── _print_list: заголовок, перечень, описания, выравнивание ────────────────


def test_print_list_lists_every_command_with_description() -> None:
    """Список без аргументов содержит каждую команду реестра и её описание."""
    result = runner.invoke(app, [])
    assert result.exit_code == 0
    for name, (desc, _) in help_mod._COMMANDS.items():
        assert name in result.stdout, f"команда {name!r} отсутствует в выводе"
        assert desc in result.stdout, f"описание команды {name!r} отсутствует"


def test_print_list_descriptions_are_column_aligned() -> None:
    """Описания выровнены в один столбец: indent(2) + max_name_len + gap(2)."""
    result = runner.invoke(app, [])
    assert result.exit_code == 0
    max_name_len = max(len(name) for name in help_mod._COMMANDS)
    expected_col = 2 + max_name_len + 2

    # Берём строки-пункты команд (двухпробельный отступ + известное имя).
    command_lines = [
        line
        for line in result.stdout.splitlines()
        if line.startswith("  ") and any(line[2:].startswith(n) for n in help_mod._COMMANDS)
    ]
    assert len(command_lines) == len(help_mod._COMMANDS)

    by_name = {name: desc for name, (desc, _) in help_mod._COMMANDS.items()}
    for line in command_lines:
        body = line[2:]
        # Имя — самый длинный известный префикс (имена пересекаются: "mpu sql"/"mpu sql-ro").
        name = max((n for n in help_mod._COMMANDS if body.startswith(n)), key=len)
        desc_index = line.index(by_name[name], len(name) + 2)
        assert desc_index == expected_col, (
            f"{name!r}: описание в колонке {desc_index}, ждали {expected_col}"
        )


def test_print_list_has_header_and_footer() -> None:
    """Список обрамлён заголовком и подсказкой про --help."""
    result = runner.invoke(app, [])
    assert result.exit_code == 0
    assert result.stdout.startswith("Available commands:")
    assert "Run `<command> --help` for detailed usage." in result.stdout


# ── _render_help: usage/options через click.Context ─────────────────────────


def test_render_help_emits_usage_and_options(capsys: pytest.CaptureFixture[str]) -> None:
    """`_render_help` печатает usage/options целевого app (rich → stdout)."""
    from mpu.commands import sql

    ret = help_mod._render_help("mpu sql", sql.app)
    # Typer с rich печатает help в console и возвращает пустую строку.
    assert isinstance(ret, str)
    captured = capsys.readouterr().out + ret
    assert "Usage" in captured
    assert "Options" in captured
    assert "mpu sql" in captured


def test_render_help_uses_prog_name_in_usage(capsys: pytest.CaptureFixture[str]) -> None:
    """Переданный prog_name попадает в строку Usage целевой справки."""
    from mpu.commands import confirm

    ret = help_mod._render_help("custom-prog", confirm.app)
    captured = capsys.readouterr().out + ret
    assert "custom-prog" in captured


# ── main: рендер справки каждой цели + ветки ошибок ─────────────────────────


def test_main_renders_help_for_every_registered_command() -> None:
    """`mpu help <name>` для каждой команды реестра отдаёт непустую справку, exit 0."""
    for name in help_mod._COMMANDS:
        result = runner.invoke(app, [name])
        assert result.exit_code == 0, f"{name!r}: exit_code {result.exit_code}"
        assert result.stdout.strip(), f"{name!r}: пустой вывод справки"


def test_main_unknown_lists_known_commands() -> None:
    """Неизвестная команда печатает в stderr список известных команд."""
    result = runner.invoke(app, ["does-not-exist"])
    assert result.exit_code == 2
    assert "unknown command 'does-not-exist'" in result.stderr
    assert "Known commands:" in result.stderr
    # хотя бы одна реальная команда перечислена
    assert "mpu search" in result.stderr


def test_main_empty_string_command_is_unknown() -> None:
    """Пустая строка как имя команды трактуется как неизвестная (exit 2)."""
    result = runner.invoke(app, [""])
    assert result.exit_code == 2
    assert "unknown command ''" in result.stderr


def test_main_renders_self_help_entry() -> None:
    """`mpu help 'mpu help'` рендерит справку самого help-app без рекурсии."""
    result = runner.invoke(app, ["mpu help"])
    assert result.exit_code == 0
    assert "Usage" in result.stdout


# ── _REGISTERED_MODULES / _COMMANDS: инварианты структуры ───────────────────


def test_registered_modules_expose_required_constants() -> None:
    """Каждый зарегистрированный модуль имеет COMMAND_NAME/COMMAND_SUMMARY/app."""
    for module in help_mod._REGISTERED_MODULES:
        name = module.COMMAND_NAME
        summary = module.COMMAND_SUMMARY
        assert isinstance(name, str) and name.startswith("mpu "), name
        assert isinstance(summary, str) and summary.strip(), name
        assert isinstance(module.app, typer.Typer), name


def test_commands_dict_built_from_registered_modules() -> None:
    """`_COMMANDS` = по записи на модуль + ручная запись 'mpu help'."""
    assert len(help_mod._COMMANDS) == len(help_mod._REGISTERED_MODULES) + 1
    for module in help_mod._REGISTERED_MODULES:
        assert help_mod._COMMANDS[module.COMMAND_NAME] == (module.COMMAND_SUMMARY, module.app)
    assert help_mod._COMMANDS["mpu help"] == ("Список команд", help_mod.app)


def test_registered_command_names_are_unique() -> None:
    """COMMAND_NAME у зарегистрированных модулей не повторяются."""
    names = [m.COMMAND_NAME for m in help_mod._REGISTERED_MODULES]
    assert len(names) == len(set(names))


# ── cli_registry smoke: импорт, kebab, согласованность с help ───────────────


def test_registry_every_entry_imports_to_typer_app() -> None:
    """Каждая запись COMMANDS импортируется и её атрибут — typer.Typer."""
    for kebab, (module_path, attr) in cli_registry.COMMANDS.items():
        module = importlib.import_module(module_path)
        obj = getattr(module, attr, None)
        assert isinstance(obj, typer.Typer), f"{kebab!r} → {module_path}.{attr} не Typer"


def test_registry_keys_are_kebab_case() -> None:
    """Все ключи COMMANDS — строгий kebab-case (lowercase, дефисы)."""
    kebab_re = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
    for kebab in cli_registry.COMMANDS:
        assert kebab_re.fullmatch(kebab), f"ключ {kebab!r} не kebab-case"


def test_registry_attrs_are_app() -> None:
    """Все записи реестра указывают на атрибут `app`."""
    for kebab, (_module_path, attr) in cli_registry.COMMANDS.items():
        assert attr == "app", f"{kebab!r}: атрибут {attr!r}, ждали 'app'"


def test_registry_consistent_with_help_registered_modules() -> None:
    """COMMAND_NAME каждого help-модуля = 'mpu '+kebab из реестра, и оба указывают на один app."""
    for module in help_mod._REGISTERED_MODULES:
        kebab = module.COMMAND_NAME.removeprefix("mpu ")
        assert kebab in cli_registry.COMMANDS, f"{kebab!r} нет в COMMANDS"
        module_path, attr = cli_registry.COMMANDS[kebab]
        registered = importlib.import_module(module_path)
        assert getattr(registered, attr) is module.app, f"{kebab!r}: разные app-объекты"


def test_help_module_registered_in_registry() -> None:
    """Запись 'mpu help' в _COMMANDS соответствует ключу 'help' реестра."""
    module_path, attr = cli_registry.COMMANDS["help"]
    assert importlib.import_module(module_path).app is help_mod.app
    assert attr == "app"
