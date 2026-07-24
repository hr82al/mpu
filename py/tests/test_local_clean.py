"""Юнит-тесты `mpu.lib.local_clean` — очистка локального стека от клиентов."""

from typing import cast

from mpu.lib import local_clean
from mpu.lib.pg import PgConn
from pg_fakes import RichConn


def test_local_client_ids_parses_and_filters() -> None:
    # только `schema_<число>` → client_id; прочие схемы игнорируются.
    conn = RichConn("sl", ss_rows=[("schema_103",), ("schema_54",), ("schema_x",), ("public",)])
    assert local_clean.local_client_ids(cast(PgConn, conn)) == [54, 103]


def test_clean_clients_empty_returns_zero() -> None:
    z = cast(PgConn, RichConn("z"))
    assert local_clean.clean_clients(z, z, z, []) == 0


def test_clean_clients_owned_workspace_removed() -> None:
    sl = RichConn("sl")
    main = RichConn("main")
    ws = RichConn("ws", fetchone_seq=[(7,), (1,)])  # user найден, workspace его → удаляем
    removed = local_clean.clean_clients(
        cast(PgConn, sl), cast(PgConn, main), cast(PgConn, ws), [103]
    )
    assert removed == 1
    # каждый слой что-то выполнил и закоммитил
    for conn in (sl, main, ws):
        assert ("commit", "") in conn.log
        assert any(kind == "execute" for kind, _ in conn.log)


def test_clean_clients_sw_user_not_found() -> None:
    sl = RichConn("sl")
    main = RichConn("main")
    ws = RichConn("ws", fetchone_seq=[None])  # нашей seed-проводки нет → пропуск
    removed = local_clean.clean_clients(
        cast(PgConn, sl), cast(PgConn, main), cast(PgConn, ws), [999]
    )
    assert removed == 0


def test_clean_clients_sw_workspace_not_ours() -> None:
    sl = RichConn("sl")
    main = RichConn("main")
    ws = RichConn("ws", fetchone_seq=[(7,), None])  # user есть, но workspace не его → не трогаем ws
    removed = local_clean.clean_clients(
        cast(PgConn, sl), cast(PgConn, main), cast(PgConn, ws), [103]
    )
    assert removed == 0
