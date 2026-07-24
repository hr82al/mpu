"""Тесты `commands/_mpuapi_runtime.py` — сборка click-команд из декларативных спек.

Сетевой слой (`SlApi`) подменяется фейком; кеш токена и креды — monkeypatch'ем
имён в namespace runtime-модуля (`read_token_cache` / `write_token_cache` /
`resolve_credentials` импортированы туда `from ... import`). CLI-команды гоняются
через click `CliRunner`; хелперы — прямыми вызовами.
"""
# Тестируем underscore-хелперы рантайма (_coerce_value/_execute/...) напрямую:
# pyright: reportPrivateUsage=false

import json
from pathlib import Path
from typing import Any, cast

import click
import pytest
from click.testing import CliRunner

from mpu.commands import _mpuapi_runtime as rt
from mpu.commands._mpuapi_spec import COMMANDS, COMMANDS_BY_NAME, FieldType
from mpu.lib.slapi import SlApiError, TokenCacheEntry

runner = CliRunner()


# --------------------------------------------------------------------------- #
# Фейки / хелперы
# --------------------------------------------------------------------------- #


class FakeSlApi:
    """Фейковый sl-back клиент: пишет request-вызовы, отдаёт заданный ответ/ошибку."""

    def __init__(self, *, response: Any = None, error: SlApiError | None = None) -> None:
        self.response = response
        self.error = error
        self.requests: list[dict[str, Any]] = []

    def request(
        self, method: str, pathname: str, *, body: Any = None, no_auth: bool = False
    ) -> Any:
        self.requests.append({"method": method, "path": pathname, "body": body, "no_auth": no_auth})
        if self.error is not None:
            raise self.error
        return self.response


def _install_api(
    monkeypatch: pytest.MonkeyPatch,
    fake: FakeSlApi,
    *,
    from_env_error: SlApiError | None = None,
) -> None:
    """Подменить `rt.SlApi` шимом, чей `from_env()` отдаёт `fake` (или бросает)."""

    class _SlApiShim:
        @staticmethod
        def from_env() -> FakeSlApi:
            if from_env_error is not None:
                raise from_env_error
            return fake

    monkeypatch.setattr(rt, "SlApi", _SlApiShim)


def _raise_creds() -> tuple[str, str]:
    raise SlApiError("creds missing")


def _boom_read(*_a: object, **_k: object) -> TokenCacheEntry | None:
    raise AssertionError("token cache must not be read")


def _noop_write(token: str) -> None:
    _ = token


# --------------------------------------------------------------------------- #
# _coerce_value
# --------------------------------------------------------------------------- #


def test_coerce_string_passthrough() -> None:
    assert rt._coerce_value("string", "hello world", field_name="x") == "hello world"


def test_coerce_number_int() -> None:
    out = rt._coerce_value("number", "42", field_name="x")
    assert out == 42
    assert isinstance(out, int)


def test_coerce_number_float() -> None:
    out = rt._coerce_value("number", "3.14", field_name="x")
    assert out == 3.14
    assert isinstance(out, float)


@pytest.mark.parametrize("raw", ["1e3", "1E3", "2.5e2"])
def test_coerce_number_scientific(raw: str) -> None:
    out = rt._coerce_value("number", raw, field_name="x")
    assert isinstance(out, float)
    assert out == float(raw)


def test_coerce_number_invalid_raises_with_field_name() -> None:
    with pytest.raises(click.BadParameter) as ei:
        rt._coerce_value("number", "abc", field_name="limit")
    msg = str(ei.value)
    assert "limit" in msg
    assert "abc" in msg


@pytest.mark.parametrize("raw", ["true", "TRUE", "Yes", "1", "on", "ON"])
def test_coerce_boolean_truthy(raw: str) -> None:
    assert rt._coerce_value("boolean", raw, field_name="f") is True


@pytest.mark.parametrize("raw", ["false", "FALSE", "No", "0", "off", "OFF"])
def test_coerce_boolean_falsy(raw: str) -> None:
    assert rt._coerce_value("boolean", raw, field_name="f") is False


def test_coerce_boolean_invalid_raises_with_field_name() -> None:
    with pytest.raises(click.BadParameter) as ei:
        rt._coerce_value("boolean", "maybe", field_name="active")
    assert "active" in str(ei.value)


def test_coerce_json_valid_dict() -> None:
    out = rt._coerce_value("json", '{"a": 1, "b": [2, 3]}', field_name="f")
    assert out == {"a": 1, "b": [2, 3]}


def test_coerce_json_valid_array() -> None:
    assert rt._coerce_value("json", "[1, 2, 3]", field_name="f") == [1, 2, 3]


def test_coerce_json_invalid_raises_with_field_name() -> None:
    with pytest.raises(click.BadParameter) as ei:
        rt._coerce_value("json", "{not json", field_name="roles")
    assert "roles" in str(ei.value)


def test_coerce_unknown_type_raises_assertion() -> None:
    # cast: намеренно подаём невалидный FieldType, чтобы покрыть defensive-ветку.
    with pytest.raises(AssertionError):
        rt._coerce_value(cast("FieldType", "weird"), "x", field_name="f")


# --------------------------------------------------------------------------- #
# _read_body_arg
# --------------------------------------------------------------------------- #


def test_read_body_arg_literal_object() -> None:
    assert rt._read_body_arg('{"a": 1}') == {"a": 1}


def test_read_body_arg_literal_array() -> None:
    assert rt._read_body_arg("[1, 2]") == [1, 2]


def test_read_body_arg_file_reads_and_parses(tmp_path: Path) -> None:
    p = tmp_path / "body.json"
    p.write_text('{"k": "значение"}', encoding="utf-8")
    assert rt._read_body_arg(f"@{p}") == {"k": "значение"}


def test_read_body_arg_missing_file_raises(tmp_path: Path) -> None:
    missing = tmp_path / "nope.json"
    with pytest.raises(click.BadParameter) as ei:
        rt._read_body_arg(f"@{missing}")
    assert "nope.json" in str(ei.value)


def test_read_body_arg_bad_json_in_file_raises(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text("{not json", encoding="utf-8")
    with pytest.raises(click.BadParameter) as ei:
        rt._read_body_arg(f"@{p}")
    assert "невалидный JSON" in str(ei.value)


def test_read_body_arg_bad_literal_raises() -> None:
    with pytest.raises(click.BadParameter) as ei:
        rt._read_body_arg("{not json")
    assert "невалидный JSON" in str(ei.value)


# --------------------------------------------------------------------------- #
# _format_path
# --------------------------------------------------------------------------- #


def test_format_path_single_param() -> None:
    spec = COMMANDS_BY_NAME["get-user"]  # /admin/user/:userId
    assert rt._format_path(spec, {"userId": "42"}) == "/admin/user/42"


def test_format_path_multiple_params() -> None:
    spec = COMMANDS_BY_NAME["get-client-module"]  # /admin/client/:clientId/modules/:module
    out = rt._format_path(spec, {"clientId": "10", "module": "wb"})
    assert out == "/admin/client/10/modules/wb"


def test_format_path_url_quotes_special_chars() -> None:
    spec = COMMANDS_BY_NAME["get-client-module"]
    out = rt._format_path(spec, {"clientId": "10", "module": "a/b c&d"})
    assert out == "/admin/client/10/modules/a%2Fb%20c%26d"


# --------------------------------------------------------------------------- #
# _build_body
# --------------------------------------------------------------------------- #


def test_build_body_collects_typed_fields() -> None:
    spec = COMMANDS_BY_NAME["update-client-module"]  # is_active: boolean required
    assert rt._build_body(spec, {"is_active": "true"}) == {"is_active": True}


def test_build_body_required_missing_raises() -> None:
    spec = COMMANDS_BY_NAME["update-client-module"]
    with pytest.raises(click.BadParameter) as ei:
        rt._build_body(spec, {})
    assert "is_active" in str(ei.value)


def test_build_body_auth_login_required_missing() -> None:
    spec = COMMANDS_BY_NAME["auth-login"]  # email+password required, not token_only
    with pytest.raises(click.BadParameter) as ei:
        rt._build_body(spec, {"email": "a@b"})  # password отсутствует
    assert "password" in str(ei.value)


def test_build_body_raw_overrides_fields() -> None:
    spec = COMMANDS_BY_NAME["create-user"]  # accepts_raw_body
    body = rt._build_body(spec, {"body_raw": '{"custom": true}', "email": "ignored@x"})
    assert body == {"custom": True}


def test_build_body_collects_when_no_raw() -> None:
    spec = COMMANDS_BY_NAME["create-user"]
    body = rt._build_body(spec, {"email": "a@b", "name": "Имя"})
    assert body == {"email": "a@b", "name": "Имя"}


def test_build_body_no_fields_returns_none() -> None:
    spec = COMMANDS_BY_NAME["list-users"]  # без body_fields
    assert rt._build_body(spec, {}) is None


def test_build_body_get_token_optional_fields_skipped() -> None:
    spec = COMMANDS_BY_NAME["get-token"]  # email/password опциональны для token_only
    assert rt._build_body(spec, {}) is None


# --------------------------------------------------------------------------- #
# _is_optional_get_token_field
# --------------------------------------------------------------------------- #


def test_is_optional_get_token_field_true_for_token_spec() -> None:
    spec = COMMANDS_BY_NAME["get-token"]
    email_field = next(f for f in spec.body_fields if f.name == "email")
    assert rt._is_optional_get_token_field(spec, email_field) is True


def test_is_optional_get_token_field_false_for_non_token_spec() -> None:
    spec = COMMANDS_BY_NAME["auth-login"]
    email_field = next(f for f in spec.body_fields if f.name == "email")
    assert rt._is_optional_get_token_field(spec, email_field) is False


# --------------------------------------------------------------------------- #
# _build_help
# --------------------------------------------------------------------------- #


def test_build_help_path_arguments_section() -> None:
    spec = COMMANDS_BY_NAME["get-user"]  # path param userId, без body
    text = rt._build_help(spec)
    assert spec.summary in text
    assert "Path arguments:" in text
    assert "userId" in text


def test_build_help_body_fields_and_raw_sections() -> None:
    spec = COMMANDS_BY_NAME["create-user"]  # body_fields + accepts_raw_body
    text = rt._build_help(spec)
    assert "Body fields" in text
    assert "(required)" in text  # email required, не token_only
    assert "--body" in text


def test_build_help_description_appended_for_token_spec() -> None:
    spec = COMMANDS_BY_NAME["get-token"]
    text = rt._build_help(spec)
    assert spec.description is not None
    assert spec.description in text


# --------------------------------------------------------------------------- #
# _print_result
# --------------------------------------------------------------------------- #


def test_print_result_none_is_noop(capsys: pytest.CaptureFixture[str]) -> None:
    rt._print_result(None)
    assert capsys.readouterr().out == ""


def test_print_result_dumps_unicode_preserving(capsys: pytest.CaptureFixture[str]) -> None:
    rt._print_result({"имя": "значение", "n": 1})
    out = capsys.readouterr().out
    assert "имя" in out  # не \uXXXX
    assert "значение" in out
    assert json.loads(out) == {"имя": "значение", "n": 1}


# --------------------------------------------------------------------------- #
# _execute — token_only (get-token)
# --------------------------------------------------------------------------- #


def test_execute_get_token_cache_hit_skips_login(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["get-token"]
    entry = TokenCacheEntry(token="CACHED", expires_at=1e12)
    monkeypatch.setattr(rt, "read_token_cache", lambda: entry)
    fake = FakeSlApi()
    _install_api(monkeypatch, fake)
    rt._execute(spec, {})
    assert capsys.readouterr().out.strip() == "CACHED"
    assert fake.requests == []  # login не вызывался


def test_execute_get_token_cache_miss_logs_and_caches(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["get-token"]
    written: list[str] = []

    def _capture_write(token: str) -> None:
        written.append(token)

    monkeypatch.setattr(rt, "read_token_cache", lambda: None)
    monkeypatch.setattr(rt, "resolve_credentials", lambda: ("env@x", "envpw"))
    monkeypatch.setattr(rt, "write_token_cache", _capture_write)
    fake = FakeSlApi(response={"accessToken": "FRESH"})
    _install_api(monkeypatch, fake)

    rt._execute(spec, {})

    assert capsys.readouterr().out.strip() == "FRESH"
    assert written == ["FRESH"]
    assert len(fake.requests) == 1
    req = fake.requests[0]
    assert req["method"] == "POST"
    assert req["path"] == "/auth/login"
    assert req["no_auth"] is True
    assert req["body"] == {"email": "env@x", "password": "envpw"}


def test_execute_get_token_explicit_creds_force_login(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["get-token"]
    monkeypatch.setattr(rt, "read_token_cache", _boom_read)  # кеш не читать
    monkeypatch.setattr(rt, "write_token_cache", _noop_write)
    fake = FakeSlApi(response={"accessToken": "EXPLICIT"})
    _install_api(monkeypatch, fake)

    rt._execute(spec, {"email": "a@b", "password": "pw"})

    assert capsys.readouterr().out.strip() == "EXPLICIT"
    assert fake.requests[0]["body"] == {"email": "a@b", "password": "pw"}


def test_execute_get_token_env_missing_fails(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["get-token"]
    monkeypatch.setattr(rt, "read_token_cache", lambda: None)
    monkeypatch.setattr(rt, "resolve_credentials", _raise_creds)
    _install_api(monkeypatch, FakeSlApi())
    with pytest.raises(SystemExit) as ei:
        rt._execute(spec, {})
    assert ei.value.code == 1
    assert "creds missing" in capsys.readouterr().err


def test_execute_get_token_non_dict_response_fails(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["get-token"]
    monkeypatch.setattr(rt, "read_token_cache", lambda: None)
    monkeypatch.setattr(rt, "resolve_credentials", lambda: ("e@x", "pw"))
    monkeypatch.setattr(rt, "write_token_cache", _noop_write)
    _install_api(monkeypatch, FakeSlApi(response=[1, 2, 3]))
    with pytest.raises(SystemExit) as ei:
        rt._execute(spec, {})
    assert ei.value.code == 1
    assert "нет accessToken" in capsys.readouterr().err


def test_execute_get_token_empty_token_fails(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["get-token"]
    monkeypatch.setattr(rt, "read_token_cache", lambda: None)
    monkeypatch.setattr(rt, "resolve_credentials", lambda: ("e@x", "pw"))
    monkeypatch.setattr(rt, "write_token_cache", _noop_write)
    _install_api(monkeypatch, FakeSlApi(response={"accessToken": ""}))
    with pytest.raises(SystemExit) as ei:
        rt._execute(spec, {})
    assert ei.value.code == 1
    assert "нет accessToken" in capsys.readouterr().err


# --------------------------------------------------------------------------- #
# _execute — обычные команды
# --------------------------------------------------------------------------- #


def test_execute_normal_get_with_path_param(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["get-user"]  # GET /admin/user/:userId
    fake = FakeSlApi(response={"id": 7, "name": "Вася"})
    _install_api(monkeypatch, fake)

    rt._execute(spec, {"userid": "7"})

    req = fake.requests[0]
    assert req["method"] == "GET"
    assert req["path"] == "/admin/user/7"
    assert req["body"] is None
    assert req["no_auth"] is False  # обычная команда → авторизованный запрос
    out = capsys.readouterr().out
    assert json.loads(out) == {"id": 7, "name": "Вася"}
    assert "Вася" in out  # unicode не экранирован


def test_execute_no_auth_command(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["auth-login"]  # no_auth=True, не token_only
    fake = FakeSlApi(response={"accessToken": "X", "user": {"id": 1}})
    _install_api(monkeypatch, fake)

    rt._execute(spec, {"email": "a@b", "password": "pw"})

    req = fake.requests[0]
    assert req["no_auth"] is True
    assert req["method"] == "POST"
    assert req["path"] == "/auth/login"
    assert req["body"] == {"email": "a@b", "password": "pw"}
    assert json.loads(capsys.readouterr().out) == {"accessToken": "X", "user": {"id": 1}}


def test_execute_path_format_and_body_coercion(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["update-client-module"]  # PATCH, 2 path params, is_active boolean
    fake = FakeSlApi(response={"ok": True})
    _install_api(monkeypatch, fake)

    rt._execute(spec, {"clientid": "10", "module": "wb", "is_active": "true"})

    req = fake.requests[0]
    assert req["method"] == "PATCH"
    assert req["path"] == "/admin/client/10/modules/wb"
    assert req["body"] == {"is_active": True}
    assert json.loads(capsys.readouterr().out) == {"ok": True}


def test_execute_none_result_no_output(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["delete-user"]  # DELETE, не token_only
    fake = FakeSlApi(response=None)
    _install_api(monkeypatch, fake)

    rt._execute(spec, {"userid": "5"})

    assert capsys.readouterr().out == ""
    assert fake.requests[0]["method"] == "DELETE"
    assert fake.requests[0]["path"] == "/admin/user/5"


def test_execute_request_error_fails(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["list-users"]
    fake = FakeSlApi(error=SlApiError("HTTP 500", status=500, body="server boom"))
    _install_api(monkeypatch, fake)
    with pytest.raises(SystemExit) as ei:
        rt._execute(spec, {})
    assert ei.value.code == 1
    err = capsys.readouterr().err
    assert "mpuapi-list-users" in err
    assert "server boom" in err  # error.body тоже печатается


def test_execute_from_env_error_fails(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spec = COMMANDS_BY_NAME["list-users"]
    _install_api(monkeypatch, FakeSlApi(), from_env_error=SlApiError("base URL не задан"))
    with pytest.raises(SystemExit) as ei:
        rt._execute(spec, {})
    assert ei.value.code == 1
    assert "base URL" in capsys.readouterr().err


# --------------------------------------------------------------------------- #
# _build_command — структура
# --------------------------------------------------------------------------- #


def test_build_command_name_and_params() -> None:
    spec = COMMANDS_BY_NAME["update-client-module"]
    cmd = rt._build_command(spec)
    assert cmd.name == "mpuapi-update-client-module"
    names = [p.name for p in cmd.params]
    assert "clientid" in names  # click нормализует argument к lowercase
    assert "module" in names
    assert "is_active" in names


def test_build_command_includes_raw_body_option() -> None:
    spec = COMMANDS_BY_NAME["create-user"]  # accepts_raw_body
    cmd = rt._build_command(spec)
    assert "body_raw" in [p.name for p in cmd.params]


# --------------------------------------------------------------------------- #
# CLI end-to-end (через _build_command + CliRunner)
# --------------------------------------------------------------------------- #


def test_cli_command_happy_path_coercion(monkeypatch: pytest.MonkeyPatch) -> None:
    spec = COMMANDS_BY_NAME["update-client-module"]
    fake = FakeSlApi(response={"ok": True})
    _install_api(monkeypatch, fake)
    cmd = rt._build_command(spec)
    res = runner.invoke(cmd, ["10", "wb", "--is_active", "yes"])
    assert res.exit_code == 0, res.output
    assert json.loads(res.output) == {"ok": True}
    req = fake.requests[0]
    assert req["method"] == "PATCH"
    assert req["path"] == "/admin/client/10/modules/wb"
    assert req["body"] == {"is_active": True}


def test_cli_command_path_quoting(monkeypatch: pytest.MonkeyPatch) -> None:
    spec = COMMANDS_BY_NAME["get-spreadsheet"]  # /admin/ss/:spreadsheetId
    fake = FakeSlApi(response={"id": "x"})
    _install_api(monkeypatch, fake)
    cmd = rt._build_command(spec)
    res = runner.invoke(cmd, ["a b/c"])
    assert res.exit_code == 0, res.output
    assert fake.requests[0]["path"] == "/admin/ss/a%20b%2Fc"


def test_cli_command_body_raw_override(monkeypatch: pytest.MonkeyPatch) -> None:
    spec = COMMANDS_BY_NAME["create-user"]
    fake = FakeSlApi(response={"id": 1})
    _install_api(monkeypatch, fake)
    cmd = rt._build_command(spec)
    res = runner.invoke(cmd, ["--email", "ignored@x", "--body", '{"raw": true}'])
    assert res.exit_code == 0, res.output
    assert fake.requests[0]["body"] == {"raw": True}


def test_cli_command_invalid_boolean_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    spec = COMMANDS_BY_NAME["update-client-module"]
    fake = FakeSlApi()
    _install_api(monkeypatch, fake)
    cmd = rt._build_command(spec)
    res = runner.invoke(cmd, ["10", "wb", "--is_active", "perhaps"])
    assert res.exit_code == 2
    assert "perhaps" in res.output or "boolean" in res.output
    assert fake.requests == []  # запрос не ушёл


def test_cli_command_required_field_missing_exit_2(monkeypatch: pytest.MonkeyPatch) -> None:
    spec = COMMANDS_BY_NAME["create-user"]  # email required, без --body
    fake = FakeSlApi()
    _install_api(monkeypatch, fake)
    cmd = rt._build_command(spec)
    res = runner.invoke(cmd, [])
    assert res.exit_code == 2
    assert "email" in res.output
    assert fake.requests == []


def test_cli_camelcase_required_field_collected(monkeypatch: pytest.MonkeyPatch) -> None:
    """camelCase body-поля (newPassword/jobId/...) должны доходить до тела запроса.

    Регрессия: click нормализует имя опции `--newPassword` к ключу kwargs
    `newpassword`, а `_build_body` ищет по `newPassword` — поле терялось. Для
    required-поля команда падала «обязателен» даже при переданном флаге.
    """
    spec = COMMANDS_BY_NAME["auth-change-password"]  # email/password/newPassword — все required
    fake = FakeSlApi(response={"ok": True})
    _install_api(monkeypatch, fake)
    cmd = rt._build_command(spec)
    res = runner.invoke(cmd, ["--email", "u@x", "--password", "old", "--newPassword", "new"])
    assert res.exit_code == 0, res.output
    assert fake.requests[0]["body"] == {"email": "u@x", "password": "old", "newPassword": "new"}


def test_cli_camelcase_optional_field_collected(monkeypatch: pytest.MonkeyPatch) -> None:
    """Optional camelCase поле (`jobId`) тоже доходит до тела, не теряется молча."""
    spec = COMMANDS_BY_NAME["ss-jobs-job"]  # accepts_raw_body, jobId optional
    fake = FakeSlApi(response={"job": None})
    _install_api(monkeypatch, fake)
    cmd = rt._build_command(spec)
    res = runner.invoke(cmd, ["--queue", "wb10x", "--jobId", "job-42"])
    assert res.exit_code == 0, res.output
    assert fake.requests[0]["body"] == {"queue": "wb10x", "jobId": "job-42"}


# --------------------------------------------------------------------------- #
# build_api_group
# --------------------------------------------------------------------------- #

_CUSTOM_COMMANDS = (
    "ss-access",
    "wb-cards-reset",
    "wb-loader-blocked",
    "wb-loader-load",
    "wb-loader-reset",
    "wb-loader-resume",
    "wb-loader-status",
)


def test_build_api_group_contains_all_declarative_specs() -> None:
    group = rt.build_api_group()
    names = set(group.commands)
    for spec in COMMANDS:
        assert spec.name in names, spec.name


def test_build_api_group_includes_custom_commands() -> None:
    names = set(rt.build_api_group().commands)
    for custom in _CUSTOM_COMMANDS:
        assert custom in names, custom


def test_build_api_group_command_count() -> None:
    group = rt.build_api_group()
    assert len(group.commands) == len(COMMANDS) + len(_CUSTOM_COMMANDS)


def test_build_api_group_subcommands_lose_prefix() -> None:
    group = rt.build_api_group()
    # subcommand'ы зарегистрированы под коротким именем, без `mpuapi-`.
    assert "get-token" in group.commands
    assert "mpuapi-get-token" not in group.commands


# --------------------------------------------------------------------------- #
# build_api_group end-to-end (через _wrapped callback)
# --------------------------------------------------------------------------- #


def test_group_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeSlApi(response={"users": []})
    _install_api(monkeypatch, fake)
    group = rt.build_api_group()
    res = runner.invoke(group, ["list-users"])
    assert res.exit_code == 0, res.output
    assert json.loads(res.output) == {"users": []}
    req = fake.requests[0]
    assert req["method"] == "GET"
    assert req["path"] == "/admin/user"
    assert req["no_auth"] is False


def test_group_request_error_exit_1(monkeypatch: pytest.MonkeyPatch) -> None:
    # _execute ловит SlApiError → _fail → SystemExit; _wrapped пробрасывает SystemExit.
    fake = FakeSlApi(error=SlApiError("HTTP 500", status=500, body="server boom"))
    _install_api(monkeypatch, fake)
    group = rt.build_api_group()
    res = runner.invoke(group, ["list-users"])
    assert res.exit_code == 1
    assert "mpuapi-list-users" in res.output
    assert "server boom" in res.output


def test_group_bad_parameter_caught_as_unexpected(monkeypatch: pytest.MonkeyPatch) -> None:
    # BadParameter из _build_body всплывает в _wrapped → except Exception → exit 1.
    fake = FakeSlApi()
    _install_api(monkeypatch, fake)
    group = rt.build_api_group()
    res = runner.invoke(group, ["update-client-module", "10", "wb", "--is_active", "nope"])
    assert res.exit_code == 1
    assert "unexpected error" in res.output
    assert fake.requests == []


def test_group_slapi_error_escaping_execute_caught(monkeypatch: pytest.MonkeyPatch) -> None:
    # Защитная ветка _wrapped (except SlApiError): _execute сам ловит SlApiError из
    # from_env/request, но если она всплывёт мимо его try (здесь — из _print_result),
    # её ловит обёртка и уводит в _fail.
    fake = FakeSlApi(response={"ok": True})
    _install_api(monkeypatch, fake)

    def _boom_print(value: object) -> None:
        raise SlApiError("print boom")

    monkeypatch.setattr(rt, "_print_result", _boom_print)
    group = rt.build_api_group()
    res = runner.invoke(group, ["list-users"])
    assert res.exit_code == 1
    assert "mpuapi-list-users" in res.output
    assert "print boom" in res.output
    assert fake.requests  # сам запрос всё же ушёл
