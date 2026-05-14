"""Резолв Portainer-контейнера по точному имени из SQLite-кэша (`mpu init`).

Используется как часть универсального селектора `mpu p ssh <name>`: для контейнеров
без `server_number` (например, `mp-dt-cli`, контейнеры парсеров) нет sl-N маппинга,
но в `portainer_containers` они есть с уникальным `container_name`.
"""

import sqlite3

from mpu.lib import store


class ContainerResolveError(RuntimeError):
    """0 совпадений или >1 (одно имя на нескольких endpoint'ах).

    `.candidates` пуст для 0 случая; для ambiguous — содержит все matched-строки
    (portainer_url, endpoint_id, endpoint_name, container_name).
    """

    def __init__(self, message: str, *, candidates: list[dict[str, object]] | None = None) -> None:
        super().__init__(message)
        self.candidates: list[dict[str, object]] = candidates or []


def find_container_targets(name: str) -> list[dict[str, object]]:
    """Все строки `portainer_containers` с `container_name = name`.

    Возвращает пустой список если кэш пуст, БД нет, таблицы нет или совпадений нет.
    Возвращаемые dict содержат `portainer_url`, `endpoint_id`, `endpoint_name`,
    `container_name` — этого достаточно для exec'а и формирования сообщения об ошибке.
    """
    try:
        with store.store() as conn:
            rows = conn.execute(
                "SELECT portainer_url, endpoint_id, endpoint_name, container_name "
                "FROM portainer_containers WHERE container_name = ?",
                (name,),
            ).fetchall()
    except sqlite3.Error:
        return []
    return [dict(r) for r in rows]


def resolve_container_target(name: str) -> tuple[str, int]:
    """`(base_url, endpoint_id)` для уникального контейнера с именем `name`.

    Бросает `ContainerResolveError` если нет совпадений (с пустым `.candidates`)
    или больше одного (с `.candidates`).
    """
    matches = find_container_targets(name)
    if not matches:
        raise ContainerResolveError(f"container {name!r} not found in Portainer cache")
    if len(matches) > 1:
        raise ContainerResolveError(
            f"container {name!r} ambiguous — matches {len(matches)} Portainer endpoints",
            candidates=matches,
        )
    row = matches[0]
    url = row["portainer_url"]
    eid = row["endpoint_id"]
    if not isinstance(url, str) or not isinstance(eid, int):
        raise ContainerResolveError(f"container {name!r}: malformed cache row")
    return url, eid


def format_container_candidates(candidates: list[dict[str, object]]) -> str:
    """Отформатировать кандидатов для error-сообщения (endpoint_name + url + id)."""
    lines: list[str] = []
    for c in candidates:
        parts = [
            f"endpoint={c.get('endpoint_name') or '?'}",
            f"id={c.get('endpoint_id')}",
            f"url={c.get('portainer_url')}",
        ]
        lines.append("  " + "  ".join(parts))
    return "\n".join(lines)
