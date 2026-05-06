"""Резолв селектора (client_id / spreadsheet_id / title / sl-N override) в server_number.

Использует `mpu-search` логику для поиска и проверяет однозначность по серверу.
Если несколько кандидатов указывают на разные сервера — ошибка с .candidates.
"""

from mpu.commands.search import search
from mpu.lib import servers, store


class ResolveError(RuntimeError):
    """Не удалось однозначно резолвнуть селектор в server_number."""

    def __init__(self, message: str, *, candidates: list[dict[str, object]] | None = None) -> None:
        super().__init__(message)
        self.candidates: list[dict[str, object]] = candidates or []


def resolve_server(
    value: str, *, server_override: str | None = None
) -> tuple[int, list[dict[str, object]]]:
    """Резолв селектора в (server_number, candidates).

    `server_override="sl-N"` обходит SQLite-резолв.
    Бросает `ResolveError` если 0 кандидатов или они на разных серверах.
    """
    if server_override:
        n = servers.server_number(server_override)
        if n is None:
            raise ResolveError(f"bad --server: {server_override!r} (expected sl-N)")
        return n, []

    with store.store() as conn:
        results = search(conn, value)

    if not results:
        raise ResolveError(f"nothing matched: {value!r}")

    distinct: set[int] = {n for r in results if isinstance(n := r.get("server_number"), int)}
    if not distinct:
        raise ResolveError(f"matched but no server resolvable: {value!r}", candidates=results)
    if len(distinct) > 1:
        raise ResolveError(
            f"ambiguous selector {value!r} — {len(results)} candidates on different servers",
            candidates=results,
        )
    return next(iter(distinct)), results
