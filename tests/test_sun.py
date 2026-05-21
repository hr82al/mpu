"""Тесты commands/sun.py."""

import json

from typer.testing import CliRunner

from mpu.commands import sun

runner = CliRunner()


def test_sun_default_coords_today() -> None:
    """mpu sun без аргументов: exit 0, валидный JSON, ключи на месте, порядок."""
    result = runner.invoke(sun.app, [])
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    assert set(data) >= {"sunrise", "solar_noon", "sunset", "day_length"}
    assert data["sunrise"] < data["solar_noon"] < data["sunset"]


def test_sun_fixed_date_is_deterministic() -> None:
    """Регрессионный пин: фиксированная дата/координаты → стабильный результат."""
    result = runner.invoke(
        sun.app, ["--lat", "55.693516", "--lon", "37.967941", "--date", "2026-06-21"]
    )
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    assert data == {
        "date": "2026-06-21",
        "latitude": 55.693516,
        "longitude": 37.967941,
        "timezone": "UTC+03:00",
        "sunrise": "2026-06-21 03:44:02",
        "solar_noon": "2026-06-21 12:29:50",
        "sunset": "2026-06-21 21:15:48",
        "day_length": "17:31:47",
    }


def test_sun_bad_date() -> None:
    result = runner.invoke(sun.app, ["--date", "21-06-2026"])
    assert result.exit_code == 2
    assert "bad --date" in result.stderr
