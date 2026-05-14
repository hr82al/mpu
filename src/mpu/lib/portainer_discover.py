"""Обнаружение контейнеров через Portainer API и кэш в SQLite (`portainer_containers`).

Кэшируем **все** контейнеры всех endpoint'ов, не только `mp-sl-N-cli`. Поле
`server_number` заполнено только для контейнеров, чьё имя матчит `mp-sl-(\\d+)-cli` —
используется в `mpu p ssh` для резолва Portainer-транспорта.

Источник конфига Portainer: `~/.config/mpu/.env` (`PORTAINER_URL`, `PORTAINER_API_KEY`,
`PORTAINER_VERIFY_TLS`). Один URL на запуск — для нескольких Portainer'ов запускать
`mpu init` повторно с `--portainer <other>`.
"""

import re
import sqlite3
import time
from dataclasses import dataclass

import typer

from mpu.lib import portainer, servers

_SERVER_NAME_PATTERN = re.compile(r"^/?mp-sl-(\d+)-cli$")


@dataclass(frozen=True)
class DiscoveredContainer:
    portainer_url: str
    endpoint_id: int
    endpoint_name: str
    container_id: str
    container_name: str
    server_number: int | None  # для mp-sl-N-cli; иначе None
    state: str
    image: str


def _extract_server_number(names: list[str]) -> int | None:
    """Берём первое имя, матчащее `mp-sl-N-cli`. None если ни одно не подошло.

    Включаем N=0 (`mp-sl-0-cli` = main). `--all` всё ещё его исключает —
    фильтр на N>0 в `list_instance_server_numbers()`.
    """
    for raw in names:
        m = _SERVER_NAME_PATTERN.match(raw)
        if m:
            return int(m.group(1))
    return None


def _primary_name(names: list[str]) -> str:
    """Первое имя без ведущего `/`. Пустая строка если список пуст."""
    return names[0].lstrip("/") if names else ""


def _coerce_str_list(value: object) -> list[str]:
    """`object` (из JSON `Any`) → `list[str]` с фильтрацией не-str элементов."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for s in value:  # type: ignore[reportUnknownVariableType]
        if isinstance(s, str):
            out.append(s)
    return out


def discover(client: portainer.Client) -> list[DiscoveredContainer]:
    """Перечислить ВСЕ endpoint'ы и ВСЕ контейнеры в каждом.

    На ошибки одного endpoint'а — typer.echo в stderr и переход к следующему.
    """
    out: list[DiscoveredContainer] = []
    for ep in client.list_endpoints():
        eid_raw = ep.get("Id")
        if not isinstance(eid_raw, int):
            continue
        ename = ep.get("Name") if isinstance(ep.get("Name"), str) else ""
        try:
            cts = client.list_containers(eid_raw)
        except Exception as e:
            typer.echo(
                f"mpu init: endpoint {eid_raw} ({ename}): {type(e).__name__}: {e}",
                err=True,
            )
            continue
        for ct in cts:
            cid_raw = ct.get("Id")
            if not isinstance(cid_raw, str) or not cid_raw:
                continue
            names = _coerce_str_list(ct.get("Names"))
            cname = _primary_name(names)
            if not cname:
                continue
            server_n = _extract_server_number(names)
            state_raw = ct.get("State")
            image_raw = ct.get("Image")
            out.append(
                DiscoveredContainer(
                    portainer_url=client.base_url,
                    endpoint_id=eid_raw,
                    endpoint_name=str(ename or ""),
                    container_id=cid_raw,
                    container_name=cname,
                    server_number=server_n,
                    state=state_raw if isinstance(state_raw, str) else "",
                    image=image_raw if isinstance(image_raw, str) else "",
                )
            )
    return out


def store_discovered(items: list[DiscoveredContainer], conn: sqlite3.Connection) -> None:
    """Записать в `portainer_containers`. PK (url, endpoint_id, container_id) → upsert."""
    now = int(time.time())
    cur = conn.cursor()
    for item in items:
        cur.execute(
            """
            INSERT INTO portainer_containers
                (portainer_url, endpoint_id, endpoint_name, container_id,
                 container_name, server_number, state, image, discovered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(portainer_url, endpoint_id, container_id) DO UPDATE SET
                endpoint_name  = excluded.endpoint_name,
                container_name = excluded.container_name,
                server_number  = excluded.server_number,
                state          = excluded.state,
                image          = excluded.image,
                discovered_at  = excluded.discovered_at
            """,
            (
                item.portainer_url,
                item.endpoint_id,
                item.endpoint_name,
                item.container_id,
                item.container_name,
                item.server_number,
                item.state,
                item.image,
                now,
            ),
        )
    conn.commit()


def make_client_from_env(portainer_url_override: str | None = None) -> portainer.Client:
    """Собрать `portainer.Client` из `~/.config/mpu/.env` (+ опциональный URL override)."""
    api_key = servers.env_value("PORTAINER_API_KEY")
    if not api_key:
        typer.echo(
            "mpu init: в ~/.config/mpu/.env нет PORTAINER_API_KEY",
            err=True,
        )
        raise typer.Exit(code=2)
    base_url = portainer_url_override or servers.env_value("PORTAINER_URL")
    if not base_url:
        typer.echo(
            "mpu init: укажите --portainer <url> либо PORTAINER_URL в ~/.config/mpu/.env",
            err=True,
        )
        raise typer.Exit(code=2)
    verify_tls = (servers.env_value("PORTAINER_VERIFY_TLS") or "").lower() == "true"
    # endpoint_id=0 — для discover мы используем _root_client, поле не задействовано.
    return portainer.Client(
        base_url=base_url, endpoint_id=0, api_key=api_key, verify_tls=verify_tls
    )


def reset_table(conn: sqlite3.Connection) -> int:
    """`DELETE FROM portainer_containers`. Возвращает кол-во удалённых строк."""
    cur = conn.execute("DELETE FROM portainer_containers")
    conn.commit()
    return cur.rowcount or 0
