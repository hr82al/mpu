"""Резолв селектора (sl-N / client_id / spreadsheet_id / title) в server_number.

Универсальный селектор: если value матчит `sl-N` — шорт-цикл (поиск пропускается),
иначе ищет через `mpu search` (client_id / spreadsheet_id substring / title substring)
и проверяет однозначность по серверу. Несколько кандидатов на разных серверах →
`ResolveError` с `.candidates`.

Для backwards-compat сохранён `server_override` — отдельный sl-N override
поверх селектора (используется в `mpu sql`).
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

    Порядок:
      1. `server_override="sl-N"` — приоритетный override, обходит селектор и поиск.
      2. `value` матчит `sl-N` — шорт-цикл, возвращает (N, []), без обращения к SQLite.
      3. Иначе — поиск через `mpu search` (client_id / spreadsheet_id / title).

    Бросает `ResolveError` если 0 кандидатов или они на разных серверах.
    """
    if server_override:
        n = servers.server_number(server_override)
        if n is None:
            raise ResolveError(f"bad --server: {server_override!r} (expected sl-N)")
        return n, []

    n = servers.server_number(value)
    if n is not None:
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


def format_candidates(candidates: list[dict[str, object]]) -> str:
    """Человекочитаемое представление списка кандидатов для err-вывода."""
    lines: list[str] = []
    for c in candidates:
        client_id = c.get("client_id")
        server = c.get("server")
        title = c.get("title")
        ss = c.get("spreadsheet_id")
        parts = [f"client_id={client_id}", f"server={server}"]
        if title:
            parts.append(f'title="{title}"')
        if ss:
            parts.append(f"spreadsheet_id={ss}")
        lines.append("  " + "  ".join(parts))
    return "\n".join(lines)
