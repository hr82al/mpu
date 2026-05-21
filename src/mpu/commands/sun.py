"""`mpu sun` — восход / зенит / закат / длина дня по координатам (offline, astral)."""

import datetime
import json
from datetime import timedelta, timezone
from typing import Annotated

import typer
from astral import Observer
from astral.sun import sun

COMMAND_NAME = "mpu sun"
COMMAND_SUMMARY = "Восход / закат / зенит / длина дня по координатам (offline)"

MSK = timezone(timedelta(hours=3))

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    lat: Annotated[float, typer.Option("--lat", help="Широта (-90..90)")] = 55.693516,
    lon: Annotated[float, typer.Option("--lon", help="Долгота (-180..180)")] = 37.967941,
    date_str: Annotated[
        str | None,
        typer.Option("--date", help="Дата YYYY-MM-DD; по умолчанию сегодня (МСК)"),
    ] = None,
) -> None:
    """Считает локально (astral, без сети) восход/закат/зенит и длину дня."""
    if date_str is None:
        day = datetime.datetime.now(MSK).date()
    else:
        try:
            day = datetime.date.fromisoformat(date_str)
        except ValueError:
            typer.echo(f"mpu sun: bad --date '{date_str}', expected YYYY-MM-DD", err=True)
            raise typer.Exit(code=2) from None

    observer = Observer(latitude=lat, longitude=lon)
    try:
        s = sun(observer, date=day, tzinfo=MSK)
    except ValueError as e:  # полярный день/ночь — солнце не восходит/заходит
        typer.echo(f"mpu sun: {e}", err=True)
        raise typer.Exit(code=1) from None

    fmt = "%Y-%m-%d %H:%M:%S"
    day_length = timedelta(seconds=round((s["sunset"] - s["sunrise"]).total_seconds()))
    result = {
        "date": day.isoformat(),
        "latitude": lat,
        "longitude": lon,
        "timezone": "UTC+03:00",
        "sunrise": s["sunrise"].strftime(fmt),
        "solar_noon": s["noon"].strftime(fmt),
        "sunset": s["sunset"].strftime(fmt),
        "day_length": str(day_length),  # H:MM:SS
    }
    typer.echo(json.dumps(result, ensure_ascii=False, indent=2))
