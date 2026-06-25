"""Тесты CLI `mpu api ss-access` (mpu.commands.ss_access).

Драйвим click.Group из `build_command()` через CliRunner, мокая два внешних
seam'а — sl-back API (`SlApi.from_env`/`api.request`) и main-PG
(`connect_main` + fake cursor/conn в стиле test_sql_runner). Покрываем
request/status/revoke/reset: happy-path, ошибки API/БД/конфига, пустой ввод,
идемпотентность.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

import psycopg
import pytest
from click.testing import CliRunner, Result

from mpu.commands import ss_access
from mpu.lib.pg import PgConfigError
from mpu.lib.slapi import SlApiError

runner = CliRunner()


# ── fakes ─────────────────────────────────────────────────────────────────────


@dataclass
class _Call:
    method: str
    pathname: str
    body: object


class _FakeApi:
    """Фейк SlApi: фиксирует вызовы request(), отдаёт/бросает по handler'у."""

    def __init__(self, handler: Callable[[str, str, object], object]) -> None:
        self._handler = handler
        self.calls: list[_Call] = []

    def request(
        self,
        method: str,
        pathname: str,
        *,
        body: object = None,
        query: object = None,
        no_auth: bool = False,
    ) -> object:
        _ = (query, no_auth)
        self.calls.append(_Call(method=method, pathname=pathname, body=body))
        return self._handler(method, pathname, body)


class _ApiFactory:
    """Подмена module-level `SlApi`: `SlApi.from_env()` → fake (или SlApiError)."""

    def __init__(self, api: _FakeApi | None, error: SlApiError | None = None) -> None:
        self._api = api
        self._error = error

    def from_env(self) -> _FakeApi:
        if self._error is not None:
            raise self._error
        assert self._api is not None
        return self._api


class _FakeCursor:
    def __init__(self, rows: Sequence[tuple[object, ...]]) -> None:
        self._rows = rows
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []

    def execute(self, sql: str, params: tuple[object, ...] | None = None) -> None:
        self.executed.append((sql, params))

    def fetchall(self) -> Sequence[tuple[object, ...]]:
        return self._rows

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *_: object) -> None:
        return None


class _FakeConn:
    def __init__(self, cur: _FakeCursor) -> None:
        self._cur = cur

    def cursor(self) -> _FakeCursor:
        return self._cur

    def __enter__(self) -> "_FakeConn":
        return self

    def __exit__(self, *_: object) -> None:
        return None


class _ConnFactory:
    """Подмена `connect_main`: на каждый вызов отдаёт fresh conn с заданными rows.

    Поддерживает последовательность наборов строк (для reset-poll) и режим ошибки.
    """

    def __init__(
        self,
        row_sets: Sequence[Sequence[tuple[object, ...]]],
        error: Exception | None = None,
    ) -> None:
        self._row_sets: list[Sequence[tuple[object, ...]]] = list(row_sets)
        self._error = error
        self.calls = 0
        self.cursors: list[_FakeCursor] = []

    def __call__(self) -> _FakeConn:
        self.calls += 1
        if self._error is not None:
            raise self._error
        rows: Sequence[tuple[object, ...]] = self._row_sets.pop(0) if self._row_sets else []
        cur = _FakeCursor(rows)
        self.cursors.append(cur)
        return _FakeConn(cur)


# ── installers ────────────────────────────────────────────────────────────────


def _set_api(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[str, str, object], object]
) -> _FakeApi:
    fake = _FakeApi(handler)
    monkeypatch.setattr(ss_access, "SlApi", _ApiFactory(fake))
    return fake


def _set_api_error(monkeypatch: pytest.MonkeyPatch, err: SlApiError) -> None:
    monkeypatch.setattr(ss_access, "SlApi", _ApiFactory(None, err))


def _set_email(monkeypatch: pytest.MonkeyPatch, email: str = "me@example.com") -> None:
    def _rc() -> tuple[str, str]:
        return email, "secret"

    monkeypatch.setattr(ss_access, "resolve_credentials", _rc)


def _set_email_error(monkeypatch: pytest.MonkeyPatch, err: SlApiError) -> None:
    def _rc() -> tuple[str, str]:
        raise err

    monkeypatch.setattr(ss_access, "resolve_credentials", _rc)


def _set_conn(monkeypatch: pytest.MonkeyPatch, factory: _ConnFactory) -> None:
    monkeypatch.setattr(ss_access, "connect_main", factory)


def _make_monotonic(values: list[float]) -> Callable[[], float]:
    it = iter(values)
    last = 0.0

    def _m() -> float:
        nonlocal last
        last = next(it, last)
        return last

    return _m


def _make_sleep_recorder() -> tuple[list[float], Callable[[float], None]]:
    sleeps: list[float] = []

    def _sleep(seconds: float) -> None:
        sleeps.append(seconds)

    return sleeps, _sleep


def _noop_sleep(_seconds: float) -> None:
    return None


def _ok(_method: str, _path: str, _body: object) -> object:
    return {"ok": True}


def _run(args: list[str]) -> Result:
    return runner.invoke(ss_access.build_command(), args)


# ── build_command / структура ─────────────────────────────────────────────────


def test_build_command_has_four_verbs() -> None:
    group = ss_access.build_command()
    assert group.name == "ss-access"
    assert sorted(group.commands.keys()) == ["request", "reset", "revoke", "status"]


def test_group_help_exit_zero() -> None:
    res = _run(["--help"])
    assert res.exit_code == 0, res.output
    assert "ss-access" in res.output or "Verbs" in res.output


def test_request_help_lists_options() -> None:
    res = _run(["request", "--help"])
    assert res.exit_code == 0, res.output
    assert "--reason" in res.output
    assert "--body" in res.output


# ── status ────────────────────────────────────────────────────────────────────


def test_status_happy(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _set_api(monkeypatch, lambda _m, _p, _b: {"grants": [1, 2]})
    res = _run(["status", "ssX"])
    assert res.exit_code == 0, res.output
    assert len(fake.calls) == 1
    assert fake.calls[0].method == "GET"
    assert fake.calls[0].pathname == "/admin/ss/ssX/my-access"
    assert '"grants"' in res.stdout


def test_status_api_error_exit_1(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_m: str, _p: str, _b: object) -> object:
        raise SlApiError("HTTP 500", status=500, body="server detail")

    _set_api(monkeypatch, boom)
    res = _run(["status", "ssX"])
    assert res.exit_code == 1
    assert "status:" in res.stderr
    assert "server detail" in res.stderr


def test_status_config_error_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_api_error(monkeypatch, SlApiError("base URL не задан"))
    res = _run(["status", "ssX"])
    assert res.exit_code == 2
    assert "конфиг sl-back API" in res.stderr


# ── request ───────────────────────────────────────────────────────────────────


def test_request_default_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _set_api(monkeypatch, _ok)
    res = _run(["request", "ssX"])
    assert res.exit_code == 0, res.output
    assert fake.calls[0].method == "POST"
    assert fake.calls[0].pathname == "/admin/ss/ssX/my-access/request"
    assert fake.calls[0].body == {
        "googleSheetsRole": ss_access.DEFAULT_ROLE,
        "reason": ss_access.DEFAULT_REASON,
        "accessTemplateId": None,
    }
    assert '"ok": true' in res.stdout


def test_request_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _set_api(monkeypatch, _ok)
    res = _run(
        [
            "request",
            "ssX",
            "--reason",
            "custom reason",
            "--role",
            "editor",
            "--template",
            "tmpl-uuid",
        ]
    )
    assert res.exit_code == 0, res.output
    assert fake.calls[0].body == {
        "googleSheetsRole": "editor",
        "reason": "custom reason",
        "accessTemplateId": "tmpl-uuid",
    }


def test_request_body_literal_overrides_everything(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _set_api(monkeypatch, _ok)
    res = _run(["request", "ssX", "--reason", "ignored", "--body", '{"x": 1}'])
    assert res.exit_code == 0, res.output
    assert fake.calls[0].body == {"x": 1}


def test_request_body_short_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _set_api(monkeypatch, _ok)
    res = _run(["request", "ssX", "-b", '{"y": 2}'])
    assert res.exit_code == 0, res.output
    assert fake.calls[0].body == {"y": 2}


def test_request_body_from_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake = _set_api(monkeypatch, _ok)
    body_file = tmp_path / "body.json"
    body_file.write_text('{"fromFile": true}', encoding="utf-8")
    res = _run(["request", "ssX", "--body", f"@{body_file}"])
    assert res.exit_code == 0, res.output
    assert fake.calls[0].body == {"fromFile": True}


def test_request_body_invalid_json_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_api(monkeypatch, _ok)
    res = _run(["request", "ssX", "--body", "not json"])
    assert res.exit_code == 2
    assert "невалидный JSON" in res.stderr


def test_request_body_missing_file_exit_2(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _set_api(monkeypatch, _ok)
    missing = tmp_path / "nope.json"
    res = _run(["request", "ssX", "--body", f"@{missing}"])
    assert res.exit_code == 2
    assert "--body @" in res.stderr


def test_request_api_error_exit_1(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_m: str, _p: str, _b: object) -> object:
        raise SlApiError("HTTP 400", status=400, body="bad request body")

    _set_api(monkeypatch, boom)
    res = _run(["request", "ssX"])
    assert res.exit_code == 1
    assert "request:" in res.stderr
    assert "bad request body" in res.stderr


def test_request_config_error_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_api_error(monkeypatch, SlApiError("creds missing"))
    res = _run(["request", "ssX"])
    assert res.exit_code == 2
    assert "конфиг sl-back API" in res.stderr


# ── revoke ────────────────────────────────────────────────────────────────────


def test_revoke_explicit_grant_id_skips_db(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _set_api(monkeypatch, lambda _m, _p, _b: {"submitted": True})
    _set_email(monkeypatch)
    conn = _ConnFactory([], error=AssertionError("connect_main must not be called"))
    _set_conn(monkeypatch, conn)

    res = _run(["revoke", "ssX", "--grant-id", "g-direct"])
    assert res.exit_code == 0, res.output
    assert conn.calls == 0
    assert fake.calls[0].method == "POST"
    assert fake.calls[0].pathname == "/admin/jobs/ss"
    assert fake.calls[0].body == {
        "type": "accessGrantRevoke",
        "data": {"grantId": "g-direct", "revokedByUserId": None, "reason": "revoke via mpu"},
    }


def test_revoke_custom_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _set_api(monkeypatch, lambda _m, _p, _b: {"submitted": True})
    _set_email(monkeypatch)
    _set_conn(monkeypatch, _ConnFactory([]))
    res = _run(["revoke", "ssX", "--grant-id", "g1", "--reason", "клиент закрыл тикет"])
    assert res.exit_code == 0, res.output
    assert fake.calls[0].body == {
        "type": "accessGrantRevoke",
        "data": {"grantId": "g1", "revokedByUserId": None, "reason": "клиент закрыл тикет"},
    }


def test_revoke_resolves_grants_from_db(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _set_api(monkeypatch, lambda _m, _p, _b: {"submitted": True})
    _set_email(monkeypatch, "me@example.com")
    conn = _ConnFactory([[("g1",), ("g2",)]])
    _set_conn(monkeypatch, conn)

    res = _run(["revoke", "ssX"])
    assert res.exit_code == 0, res.output
    # два submit'а — по одному на резолвнутый grant
    assert [c.pathname for c in fake.calls] == ["/admin/jobs/ss", "/admin/jobs/ss"]
    assert fake.calls[0].body == {
        "type": "accessGrantRevoke",
        "data": {"grantId": "g1", "revokedByUserId": None, "reason": "revoke via mpu"},
    }
    assert fake.calls[1].body == {
        "type": "accessGrantRevoke",
        "data": {"grantId": "g2", "revokedByUserId": None, "reason": "revoke via mpu"},
    }
    # SQL получил (spreadsheet_id, email) как параметры
    sql, params = conn.cursors[0].executed[0]
    assert "spreadsheets_access_grants" in sql
    assert "grantee_email" in sql
    assert params == ("ssX", "me@example.com")


def test_revoke_empty_no_grants(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_m: str, _p: str, _b: object) -> object:
        raise AssertionError("API must not be called when nothing to revoke")

    _set_api(monkeypatch, boom)
    _set_email(monkeypatch)
    _set_conn(monkeypatch, _ConnFactory([[]]))
    res = _run(["revoke", "ssX"])
    assert res.exit_code == 0, res.output
    assert "не найдено" in res.stdout
    assert "Нечего отзывать" in res.stdout


def test_revoke_empty_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_api(monkeypatch, _ok)
    _set_email(monkeypatch)
    _set_conn(monkeypatch, _ConnFactory([[], []]))
    first = _run(["revoke", "ssX"])
    second = _run(["revoke", "ssX"])
    assert first.exit_code == 0 and second.exit_code == 0
    assert first.stdout == second.stdout


def test_revoke_db_error_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_api(monkeypatch, _ok)
    _set_email(monkeypatch)
    _set_conn(monkeypatch, _ConnFactory([], error=psycopg.Error("connection refused")))
    res = _run(["revoke", "ssX"])
    assert res.exit_code == 2
    assert "main-БД" in res.stderr


def test_revoke_db_config_error_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_api(monkeypatch, _ok)
    _set_email(monkeypatch)
    _set_conn(monkeypatch, _ConnFactory([], error=PgConfigError("pg_0 не найдено")))
    res = _run(["revoke", "ssX"])
    assert res.exit_code == 2
    assert "main-БД" in res.stderr


def test_revoke_credentials_error_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_api(monkeypatch, _ok)
    _set_email_error(monkeypatch, SlApiError("TOKEN_EMAIL missing"))
    res = _run(["revoke", "ssX"])
    assert res.exit_code == 2
    assert "конфиг credentials" in res.stderr


def test_revoke_submit_api_error_exit_1(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_m: str, _p: str, _b: object) -> object:
        raise SlApiError("HTTP 502", status=502, body="job queue down")

    _set_api(monkeypatch, boom)
    _set_email(monkeypatch)
    _set_conn(monkeypatch, _ConnFactory([[("g1",)]]))
    res = _run(["revoke", "ssX"])
    assert res.exit_code == 1
    assert "revoke job submit" in res.stderr
    assert "job queue down" in res.stderr


# ── reset ─────────────────────────────────────────────────────────────────────


def test_reset_revoke_then_request(monkeypatch: pytest.MonkeyPatch) -> None:
    """grant в индексе → revoke → сразу пусто → финальный request."""
    fake = _set_api(monkeypatch, _ok)
    _set_email(monkeypatch)
    # call A: [g1] (резолв перед revoke); call B: [] (poll — вышел из индекса)
    _set_conn(monkeypatch, _ConnFactory([[("g1",)], []]))
    monkeypatch.setattr(ss_access.time, "monotonic", _make_monotonic([0.0]))
    sleeps, sleep_fn = _make_sleep_recorder()
    monkeypatch.setattr(ss_access.time, "sleep", sleep_fn)

    res = _run(["reset", "ssX"])
    assert res.exit_code == 0, res.output
    assert sleeps == []  # poll сразу пуст → без ожидания
    # POST revoke, затем POST финального request
    assert [c.pathname for c in fake.calls] == [
        "/admin/jobs/ss",
        "/admin/ss/ssX/my-access/request",
    ]
    assert fake.calls[0].body == {
        "type": "accessGrantRevoke",
        "data": {"grantId": "g1", "revokedByUserId": None, "reason": "reset via mpu"},
    }
    assert fake.calls[1].body == {
        "googleSheetsRole": ss_access.DEFAULT_ROLE,
        "reason": ss_access.DEFAULT_REASON,
        "accessTemplateId": None,
    }
    assert "отозвано 1" in res.stderr


def test_reset_polls_until_index_clears(monkeypatch: pytest.MonkeyPatch) -> None:
    """grant ещё в индексе один цикл → sleep → затем пусто → request."""
    fake = _set_api(monkeypatch, _ok)
    _set_email(monkeypatch)
    # A:[g1] revoke; B:[g1] still present → sleep; C:[] cleared
    _set_conn(monkeypatch, _ConnFactory([[("g1",)], [("g1",)], []]))
    monkeypatch.setattr(ss_access.time, "monotonic", _make_monotonic([0.0, 1.0]))
    sleeps, sleep_fn = _make_sleep_recorder()
    monkeypatch.setattr(ss_access.time, "sleep", sleep_fn)

    res = _run(["reset", "ssX"])
    assert res.exit_code == 0, res.output
    assert sleeps == [3.0]  # _REVOKE_POLL_INTERVAL_S
    assert fake.calls[-1].pathname == "/admin/ss/ssX/my-access/request"


def test_reset_no_initial_grants(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ничего не в индексе → без revoke и без 'отозвано', сразу request."""
    fake = _set_api(monkeypatch, _ok)
    _set_email(monkeypatch)
    _set_conn(monkeypatch, _ConnFactory([[], []]))
    monkeypatch.setattr(ss_access.time, "monotonic", _make_monotonic([0.0]))
    monkeypatch.setattr(ss_access.time, "sleep", _noop_sleep)

    res = _run(["reset", "ssX"])
    assert res.exit_code == 0, res.output
    assert [c.pathname for c in fake.calls] == ["/admin/ss/ssX/my-access/request"]
    assert "отозвано" not in res.stderr


def test_reset_timeout_exit_1(monkeypatch: pytest.MonkeyPatch) -> None:
    """grant не выходит из индекса дольше таймаута → exit 1 с подсказкой."""
    _set_api(monkeypatch, _ok)
    _set_email(monkeypatch)
    # A:[g1] revoke; затем всегда [g1] (пустой row_sets → дефолт [g1] недоступен,
    # потому отдаём бесконечный конвейер через большой список)
    conn = _ConnFactory([[("g1",)]] + [[("g1",)]] * 5)
    _set_conn(monkeypatch, conn)
    # deadline = monotonic()+60 (call1=0 → 60); первый in-loop check call2=100 > 60 → fail
    monkeypatch.setattr(ss_access.time, "monotonic", _make_monotonic([0.0, 100.0]))
    monkeypatch.setattr(ss_access.time, "sleep", _noop_sleep)

    res = _run(["reset", "ssX"])
    assert res.exit_code == 1
    assert "revoke не отработал" in res.stderr
    assert "попробуй:" in res.stderr


def test_reset_credentials_error_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_api(monkeypatch, _ok)
    _set_email_error(monkeypatch, SlApiError("TOKEN_EMAIL missing"))
    res = _run(["reset", "ssX"])
    assert res.exit_code == 2
    assert "конфиг credentials" in res.stderr


def test_reset_config_error_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    """`_token_email` ок, но `_api` падает на конфиге → exit 2."""
    _set_email(monkeypatch)
    _set_api_error(monkeypatch, SlApiError("base URL не задан"))
    res = _run(["reset", "ssX"])
    assert res.exit_code == 2
    assert "конфиг sl-back API" in res.stderr
