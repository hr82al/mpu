"""Smoke-тест верхнего уровня CLI."""

from typer.testing import CliRunner

from mpu import __version__
from mpu.cli import app

runner = CliRunner()


def test_help() -> None:
    """Проверяет: `mpu --help` возвращает 0 и содержит описание утилиты."""
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "Monorepo Python utilities" in result.stdout


def test_version() -> None:
    """Проверяет: `mpu version` печатает текущий __version__."""
    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert result.stdout.strip() == __version__
