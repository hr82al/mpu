"""`mpu help` — список доступных команд и справка по ним."""

from typing import Annotated

import click
import typer

from mpu.commands import (
    app_migrations,
    backup_ozon_unit_proto,
    backup_wb_unit_manual_data,
    backup_wb_unit_proto,
    clean_local_clients,
    clients_migrations,
    config,
    confirm,
    copy_client,
    copy_dev,
    copy_shared,
    d2_miro,
    data_loader,
    data_loader_jobs,
    datasets_migrations,
    glab_status,
    health,
    iu_wb,
    kiten,
    log,
    logs,
    make_schema,
    move_client,
    move_client_back,
    mp_init,
    mr,
    ozon_fix_fo_tax,
    ozon_jobs,
    ozon_loader,
    process,
    ps,
    pssh,
    recalculate_ozon_expenses,
    recalculate_wb_expenses,
    run_js,
    save_ozon_expenses,
    save_wb_expenses,
    search,
    sheet,
    sql,
    sql_ro,
    ss_datasets,
    ss_load,
    ss_update,
    sun,
    telegram,
    update,
    users,
    wb_jobs,
    wb_loader,
    wb_unit_calc,
    wb_unit_proto_new,
    xlsx,
)


def _print_list() -> None:
    typer.echo("Available commands:\n")
    max_name_len = max(len(name) for name in _COMMANDS)
    for name, (desc, _) in _COMMANDS.items():
        padding = " " * (max_name_len - len(name) + 2)
        typer.echo(f"  {name}{padding}{desc}")
    typer.echo("\nRun `<command> --help` for detailed usage.")


def _render_help(prog_name: str, target: typer.Typer) -> str:
    """Сгенерировать `--help` чужого typer-app без subprocess.

    typer.main.get_command(app) возвращает click.Group/Command; ctx.get_help()
    отдаёт ровно тот же текст, что и `<cmd> --help`, но без SystemExit.
    """
    cmd = typer.main.get_command(target)
    ctx = click.Context(cmd, info_name=prog_name)
    return cmd.get_help(ctx)


app = typer.Typer(
    no_args_is_help=False,
    context_settings={"help_option_names": ["-h", "--help"]},
)


@app.command()
def main(
    command: Annotated[
        str | None, typer.Argument(help="Команда для показа справки (опционально)")
    ] = None,
) -> None:
    """Список всех mpu команд с опциональной справкой."""
    if command is None:
        _print_list()
        return

    entry = _COMMANDS.get(command)
    if entry is None:
        typer.echo(f"mpu help: unknown command '{command}'", err=True)
        typer.echo(f"Known commands: {', '.join(_COMMANDS.keys())}", err=True)
        raise typer.Exit(code=2)

    _, target_app = entry
    typer.echo(_render_help(command, target_app))


_REGISTERED_MODULES = (
    app_migrations,
    backup_ozon_unit_proto,
    backup_wb_unit_manual_data,
    backup_wb_unit_proto,
    clean_local_clients,
    clients_migrations,
    config,
    confirm,
    copy_client,
    copy_dev,
    copy_shared,
    d2_miro,
    data_loader,
    data_loader_jobs,
    datasets_migrations,
    glab_status,
    health,
    iu_wb,
    kiten,
    log,
    logs,
    make_schema,
    move_client,
    move_client_back,
    mp_init,
    mr,
    ozon_fix_fo_tax,
    ozon_jobs,
    ozon_loader,
    process,
    ps,
    pssh,
    recalculate_ozon_expenses,
    recalculate_wb_expenses,
    run_js,
    save_ozon_expenses,
    save_wb_expenses,
    search,
    sheet,
    sql,
    sql_ro,
    ss_datasets,
    ss_load,
    ss_update,
    sun,
    telegram,
    update,
    users,
    wb_jobs,
    wb_loader,
    wb_unit_calc,
    wb_unit_proto_new,
    xlsx,
)

_COMMANDS: dict[str, tuple[str, typer.Typer]] = {
    m.COMMAND_NAME: (m.COMMAND_SUMMARY, m.app) for m in _REGISTERED_MODULES
}
_COMMANDS["mpu help"] = ("Список команд", app)
