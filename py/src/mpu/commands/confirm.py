"""`mpu confirm` — y/N gate в pipe.

Читает весь stdin, показывает его в stderr, спрашивает подтверждение у терминала (а не со
stdin — он занят данными пайпа). На `y` — пишет буфер в stdout (→ следующая команда пайпа),
на `n`/EOF/нет терминала — ничего не пишет и `Exit` (downstream получит пустой stdin → no-op).

Терминал открывается через сырой `os.open`/`os.read`/`os.write` (text-mode `open(tty, "r+")`
падает на tty с "not seekable"). Источник: сначала controlling `/dev/tty`, иначе pty-устройство
любого std-fd, который реально tty (stdout/stderr часто подключены к терминалу даже в пайпе).

Пример: `mpu iu-wb <ssid> fix-formulas | mpu confirm | mpu sheet set <ssid>`.
"""

from __future__ import annotations

import os
import sys
from typing import Annotated

import typer

COMMAND_NAME = "mpu confirm"
COMMAND_SUMMARY = "y/N gate в pipe: показать stdin, спросить, пропустить дальше или прервать"

app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


class _NoTtyError(OSError):
    """Нет доступного терминала ни через /dev/tty, ни через std-fd."""


def _tty_path() -> str | None:
    """Путь к терминалу: controlling `/dev/tty`, иначе pts любого tty-fd (stdout/stderr/stdin)."""
    try:
        fd = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
        os.close(fd)
        return "/dev/tty"
    except OSError:
        pass
    for fd in (1, 2, 0):
        try:
            if os.isatty(fd):
                return os.ttyname(fd)
        except OSError:
            continue
    return None


def _ask_tty(message: str) -> bool:
    """Спросить y/N напрямую у терминала (raw os.read/write). Нет терминала → _NoTtyError."""
    path = _tty_path()
    if path is None:
        raise _NoTtyError
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY)
    try:
        os.write(fd, f"{message} [y/N] ".encode())
        ans = os.read(fd, 1024).decode("utf-8", "replace").strip().lower()
    finally:
        os.close(fd)
    return ans in ("y", "yes")


def _tty_diagnostics() -> str:
    """Что mpu видит на fd 0/1/2 и доступен ли /dev/tty — для отладки запуска."""
    lines: list[str] = []
    try:
        fd = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
        os.close(fd)
        lines.append("/dev/tty: OK (os.open)")
    except OSError as e:
        lines.append(f"/dev/tty: {e}")
    for fd, name in ((0, "stdin"), (1, "stdout"), (2, "stderr")):
        try:
            tn = os.ttyname(fd)
        except OSError as e:
            tn = f"({e})"
        lines.append(f"fd{fd} {name}: isatty={os.isatty(fd)} ttyname={tn}")
    return "\n".join(lines)


@app.command()
def main(
    message: Annotated[
        str, typer.Option("-m", "--message", help="Текст подтверждения")
    ] = "Применить?",
    assume_yes: Annotated[
        bool, typer.Option("-y", "--yes", help="Не спрашивать — пропустить всё (для скриптов)")
    ] = False,
) -> None:
    """Пропустить stdin → stdout по подтверждению; иначе прервать pipe."""
    data = sys.stdin.read()
    sys.stderr.write(data)
    if not data.endswith("\n"):
        sys.stderr.write("\n")
    sys.stderr.flush()

    if not assume_yes:
        try:
            ok = _ask_tty(message)
        except _NoTtyError:
            typer.echo(
                f"{COMMAND_NAME}: терминал недоступен для подтверждения. "
                "Используй `--yes` или two-step "
                "(`<команда> > /tmp/x.json` → проверить → `mpu sheet set <ssid> < /tmp/x.json`).\n"
                "--- tty диагностика (как запущен mpu) ---\n" + _tty_diagnostics(),
                err=True,
            )
            raise typer.Exit(2) from None
        if not ok:
            typer.echo(f"{COMMAND_NAME}: отменено — pipe прерван.", err=True)
            raise typer.Exit(1)

    sys.stdout.write(data)
    sys.stdout.flush()
