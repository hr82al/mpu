"""Общий запуск переноса клиента через `clientsTransfer createJob`.

Используется и `mpu move-client`, и `mpu move-client-back` — обе строят один и тот же
вызов `node cli service:clientsTransfer createJob --source ... --target ... --client-id ...
--destroy` и запускают его в контейнере `mp-dt-cli` через Portainer. `createJob` кладёт
BullMQ-job в очередь `transferClient`; реальный перенос делают воркеры.
"""

import shlex

import typer

from mpu.lib import containers, pssh

MP_DT_CONTAINER = "mp-dt-cli"


def run_transfer(command_name: str, client_id: int, *, source_n: int, target_n: int) -> int:
    """Поставить job переноса client_id с sl-`source_n` на sl-`target_n`. Вернуть rc.

    `command_name` используется в сообщениях об ошибках (имя вызывающей команды).
    Бросает `typer.Exit(2)` если контейнер `mp-dt-cli` не резолвится.
    """
    cmd = [
        "node",
        "cli",
        "service:clientsTransfer",
        "createJob",
        "--source",
        f"sl-{source_n}",
        "--target",
        f"sl-{target_n}",
        "--client-id",
        str(client_id),
        "--destroy",
    ]
    typer.echo(f"$ {shlex.join(cmd)}  (in {MP_DT_CONTAINER})", err=True)
    try:
        return pssh.pssh_run_container(container=MP_DT_CONTAINER, cmd=cmd)
    except containers.ContainerResolveError as e:
        typer.echo(f"{command_name}: {e}", err=True)
        if e.candidates:
            typer.echo(containers.format_container_candidates(e.candidates), err=True)
        else:
            typer.echo(
                f"{command_name}: запусти `mpu init` для обновления Portainer-кэша",
                err=True,
            )
        raise typer.Exit(code=2) from None
