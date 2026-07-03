"""Pydantic-модели wire-формата Loki `/query_range` — типизированная граница `lib/loki.py`.

Модуль импортируется ЛЕНИВО (из тела функции разбора): pydantic стоит ~150 мс импорта,
а `cli.py` жадно грузит все команды — ленивая граница держит startup `mpu` нейтральным.

Терпимость к мусору сохранена как у ручного парсера (см. tests/test_loki.py):
верхний уровень не по схеме → пустой список; мусорный stream/пара/лейбл — пропуск
ровно этой единицы, остальное парсится.
"""

from typing import TypeGuard

from pydantic import BaseModel, Field, ValidationError, field_validator

from mpu.lib.loki import LogEntry


def _as_dict(o: object) -> TypeGuard[dict[object, object]]:
    return isinstance(o, dict)


def _as_list(o: object) -> TypeGuard[list[object]]:
    return isinstance(o, list)


class StreamBlock(BaseModel):
    """Один элемент `data.result[]`: лейблы потока + пары `[ts_ns, line]`."""

    labels: dict[str, str] = Field(default_factory=dict, alias="stream")
    values: list[tuple[int, str]] = Field(default_factory=list[tuple[int, str]])

    @field_validator("labels", mode="before")
    @classmethod
    def _keep_str_pairs(cls, raw: object) -> dict[str, str]:
        """Не-dict → пустые лейблы; нестроковые ключи/значения отбрасываются поштучно."""
        if not _as_dict(raw):
            return {}
        return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str)}

    @field_validator("values", mode="before")
    @classmethod
    def _keep_valid_pairs(cls, raw: object) -> list[tuple[str, str]]:
        """Пара не-list / короткая / нестроковая / непарсимый ts — пропуск; хвост >2 игнор."""
        if not _as_list(raw):
            return []
        pairs: list[tuple[str, str]] = []
        for pair in raw:
            if not _as_list(pair) or len(pair) < 2:  # noqa: PLR2004
                continue
            ts, line = pair[0], pair[1]
            if isinstance(ts, str) and isinstance(line, str) and _is_int(ts):
                pairs.append((ts, line))
        return pairs


class QueryRangeData(BaseModel):
    result: list[object] = Field(default_factory=list[object])


class QueryRangeResponse(BaseModel):
    data: QueryRangeData


def _is_int(raw: str) -> bool:
    try:
        int(raw)
    except ValueError:
        return False
    return True


def parse_query_range(data: object) -> list[LogEntry]:
    """JSON `/query_range` → плоский список `LogEntry`. Любое отклонение схемы → `[]`."""
    try:
        resp = QueryRangeResponse.model_validate(data)
    except ValidationError:
        return []
    entries: list[LogEntry] = []
    for raw_stream in resp.data.result:
        try:
            block = StreamBlock.model_validate(raw_stream)
        except ValidationError:
            continue
        entries.extend(
            LogEntry(ts_ns=ts_ns, line=line, labels=block.labels) for ts_ns, line in block.values
        )
    return entries
