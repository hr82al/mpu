"""Loki HTTP client — `/loki/api/v1/query_range` для tail-семантики `mpu logs`.

Без auth (Loki в стенде доступен напрямую по приватной сети). `LOKI_URL` берётся
из `~/.config/mpu/.env` через `servers.env_value`. Если поле не задано — caller
должен сам вернуть `typer.Exit(2)` с понятной ошибкой.
"""

from dataclasses import dataclass
from typing import cast

import httpx


@dataclass(frozen=True, slots=True)
class LogEntry:
    ts_ns: int
    line: str
    labels: dict[str, str]


def query_range(
    *,
    base_url: str,
    logql: str,
    start_ns: int,
    end_ns: int,
    limit: int,
    direction: str = "backward",
    timeout: float = 30.0,
) -> list[LogEntry]:
    """`GET {base_url}/loki/api/v1/query_range` → плоский список записей.

    Loki возвращает `result[].values[][ts_ns_string, line]`. Ровняем в плоский
    список `LogEntry`; caller сам сортирует/печатает.

    `direction="backward"` означает "сначала свежие" — нужно для tail-tail. Caller
    обычно потом сортирует ascending для хронологического вывода.
    """
    params = {
        "query": logql,
        "start": str(start_ns),
        "end": str(end_ns),
        "limit": str(limit),
        "direction": direction,
    }
    with httpx.Client(base_url=base_url, timeout=timeout, trust_env=False) as c:
        r = c.get("/loki/api/v1/query_range", params=params)
        r.raise_for_status()
        data = r.json()

    return _parse_query_range_response(data)


def _parse_query_range_response(data: object) -> list[LogEntry]:
    """Извлечь LogEntry из JSON. На любые отклонения схемы — пустой список."""
    if not isinstance(data, dict):
        return []
    result_obj = cast(dict[str, object], data).get("data")
    if not isinstance(result_obj, dict):
        return []
    streams = cast(dict[str, object], result_obj).get("result")
    if not isinstance(streams, list):
        return []

    out: list[LogEntry] = []
    streams_list = cast(list[object], streams)
    for stream in streams_list:
        if not isinstance(stream, dict):
            continue
        stream_obj = cast(dict[str, object], stream)
        labels_raw = stream_obj.get("stream")
        labels: dict[str, str] = {}
        if isinstance(labels_raw, dict):
            for k, v in cast(dict[object, object], labels_raw).items():
                if isinstance(k, str) and isinstance(v, str):
                    labels[k] = v
        values_raw = stream_obj.get("values")
        if not isinstance(values_raw, list):
            continue
        for pair in cast(list[object], values_raw):
            if not isinstance(pair, list) or len(cast(list[object], pair)) < 2:
                continue
            pair_list = cast(list[object], pair)
            ts_str = pair_list[0]
            line = pair_list[1]
            if not isinstance(ts_str, str) or not isinstance(line, str):
                continue
            try:
                ts_ns = int(ts_str)
            except ValueError:
                continue
            out.append(LogEntry(ts_ns=ts_ns, line=line, labels=labels))
    return out
