"""Tests for mpu-help command."""

from typer.testing import CliRunner

from mpu.commands.help import app

runner = CliRunner()


def test_list_no_args() -> None:
    """Вывод списка без аргументов должен содержать все команды."""
    result = runner.invoke(app, [])
    assert result.exit_code == 0
    assert "mpu-search" in result.stdout
    assert "mpu-update" in result.stdout
    assert "mpu-sql" in result.stdout
    assert "mpu-backup-wb-unit-proto" in result.stdout
    assert "mpu-backup-ozon-unit-proto" in result.stdout
    assert "mpu-help" in result.stdout
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
