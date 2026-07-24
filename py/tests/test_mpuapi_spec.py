"""Структурные инварианты декларативного каталога `_mpuapi_spec.COMMANDS`.

Каталог — единственный source of truth для всех `mpu api <X>` команд; `_mpuapi_runtime`
строит из него typer-app. Поэтому ошибка в спеке (дубль имени, рассинхрон placeholder'ов
в `path` с `path_params`, неверный HTTP-метод / тип поля, потерянный `summary`) ломает
команду молча. Здесь проверяются эти инварианты по всему каталогу + фабрики `_jobs_group`
и валидаторы `_validate_spec` / `_validate_all` напрямую (включая error-пути).
"""

from dataclasses import FrozenInstanceError
from typing import get_args

import pytest

from mpu.commands import _mpuapi_spec as spec_mod
from mpu.commands._mpuapi_spec import (
    BIN_PREFIX,
    CLIENT_ID,
    COMMANDS,
    COMMANDS_BY_NAME,
    JOBS_BODY,
    SS_ID,
    SS_ID_SNAKE,
    USER_ID,
    BodyField,
    CommandSpec,
    FieldType,
    HttpMethod,
    PathParam,
    # white-box: внутренние фабрика/валидаторы спека тестируются напрямую (cross-module private)
    _jobs_group,  # pyright: ignore[reportPrivateUsage]
    _validate_all,  # pyright: ignore[reportPrivateUsage]
    _validate_spec,  # pyright: ignore[reportPrivateUsage]
    all_path_param_names,
    bin_name,
)

VALID_METHODS: frozenset[str] = frozenset(get_args(HttpMethod))
VALID_FIELD_TYPES: frozenset[str] = frozenset(get_args(FieldType))


def _placeholders(path: str) -> list[str]:
    """Сегменты `:name` пути → их имена в порядке появления (как в `_validate_spec`)."""
    return [seg[1:] for seg in path.split("/") if seg.startswith(":")]


# ──────────────────────────────────────────────────────────────────────────────
# Инварианты по всему каталогу COMMANDS
# ──────────────────────────────────────────────────────────────────────────────


def test_catalog_non_empty() -> None:
    """Каталог не пуст — иначе `mpu api` остался бы без команд."""
    assert len(COMMANDS) > 0


def test_command_names_unique() -> None:
    """Имена команд уникальны (иначе bin-коллизия и затёртая команда)."""
    names = [c.name for c in COMMANDS]
    assert len(names) == len(set(names))


def test_command_names_kebab_lowercase() -> None:
    """Имена — kebab-case в нижнем регистре (становятся именем bin'а)."""
    for spec in COMMANDS:
        assert spec.name == spec.name.lower()
        assert " " not in spec.name
        assert "_" not in spec.name


def test_bin_names_unique_and_prefixed() -> None:
    """`bin_name` префиксует именем `mpuapi-` и сохраняет уникальность."""
    bins = [bin_name(c) for c in COMMANDS]
    for spec, b in zip(COMMANDS, bins, strict=True):
        assert b == f"{BIN_PREFIX}{spec.name}"
        assert b.startswith("mpuapi-")
    assert len(bins) == len(set(bins))


def test_paths_absolute() -> None:
    """Каждый path начинается со `/` (склеивается с base URL клиента)."""
    for spec in COMMANDS:
        assert spec.path.startswith("/"), spec.name


def test_summaries_non_empty() -> None:
    """У каждой команды непустой `summary` (попадает в typer help)."""
    for spec in COMMANDS:
        assert spec.summary.strip(), spec.name


def test_method_in_valid_set() -> None:
    """HTTP-метод каждой команды — из разрешённого Literal-набора."""
    for spec in COMMANDS:
        assert spec.method in VALID_METHODS, (spec.name, spec.method)


def test_field_types_in_valid_set() -> None:
    """`field.type` каждого body-поля — из разрешённого FieldType-набора."""
    for spec in COMMANDS:
        for field in spec.body_fields:
            assert field.type in VALID_FIELD_TYPES, (spec.name, field.name, field.type)


def test_placeholders_match_path_params() -> None:
    """Для каждой команды `:placeholder`-сегменты пути == объявленным path_params (по порядку)."""
    for spec in COMMANDS:
        assert _placeholders(spec.path) == list(all_path_param_names(spec)), spec.name


def test_body_field_names_unique_per_spec() -> None:
    """Имена body-полей уникальны внутри одной команды (иначе затёртая опция)."""
    for spec in COMMANDS:
        names = [f.name for f in spec.body_fields]
        assert len(names) == len(set(names)), spec.name


def test_token_only_only_on_get_token() -> None:
    """`token_only` стоит ровно у `get-token` и больше нигде."""
    token_only = [c.name for c in COMMANDS if c.token_only]
    assert token_only == ["get-token"]


def test_no_auth_only_on_auth_login() -> None:
    """`no_auth` стоит только у команд с путём `/auth/login` (логин до авторизации)."""
    for spec in COMMANDS:
        if spec.no_auth:
            assert spec.path == "/auth/login", spec.name


def test_get_token_shape() -> None:
    """`get-token` — POST /auth/login, no_auth + token_only одновременно."""
    spec = COMMANDS_BY_NAME["get-token"]
    assert spec.method == "POST"
    assert spec.path == "/auth/login"
    assert spec.no_auth is True
    assert spec.token_only is True


def test_path_params_have_descriptions() -> None:
    """У каждого path-параметра непустые name и description."""
    for spec in COMMANDS:
        for param in spec.path_params:
            assert param.name, spec.name
            assert param.description, spec.name


def test_body_fields_have_descriptions() -> None:
    """У каждого body-поля непустые name и description."""
    for spec in COMMANDS:
        for field in spec.body_fields:
            assert field.name, spec.name
            assert field.description, spec.name


# ──────────────────────────────────────────────────────────────────────────────
# COMMANDS_BY_NAME + общие константы
# ──────────────────────────────────────────────────────────────────────────────


def test_commands_by_name_consistent() -> None:
    """Индекс по имени покрывает весь каталог и резолвит в тот же объект."""
    assert len(COMMANDS_BY_NAME) == len(COMMANDS)
    for spec in COMMANDS:
        assert COMMANDS_BY_NAME[spec.name] is spec


def test_shared_pathparam_constants() -> None:
    """Переиспользуемые PathParam-константы нормализуются в ожидаемые имена."""
    assert CLIENT_ID.name == "clientId"
    assert USER_ID.name == "userId"
    assert SS_ID.name == "spreadsheetId"
    assert SS_ID_SNAKE.name == "spreadsheet_id"


def test_jobs_body_field_names_unique() -> None:
    """Общий JOBS_BODY — без дублей полей и весь в валидных типах."""
    names = [f.name for f in JOBS_BODY]
    assert len(names) == len(set(names))
    for field in JOBS_BODY:
        assert field.type in VALID_FIELD_TYPES


# ──────────────────────────────────────────────────────────────────────────────
# Фабрика _jobs_group
# ──────────────────────────────────────────────────────────────────────────────


def test_jobs_group_structure() -> None:
    """`_jobs_group` строит 5 POST-команд с raw-body и общим JOBS_BODY."""
    group = _jobs_group("wb-jobs", "wb")
    assert [c.name for c in group] == [
        "wb-jobs-queue-status",
        "wb-jobs-active-jobs",
        "wb-jobs-by-state",
        "wb-jobs-job",
        "wb-jobs-abort",
    ]
    for spec in group:
        assert spec.method == "POST"
        assert spec.accepts_raw_body is True
        assert spec.body_fields is JOBS_BODY
        assert spec.path.startswith("/admin/jobs/jobsControl/wb/")
        assert spec.summary == f"POST {spec.path}"


def test_jobs_group_by_state_path_segment() -> None:
    """Суффикс `by-state` маппится на сегмент пути `jobs-by-state` (не `by-state`)."""
    group = _jobs_group("ozon-jobs", "ozon")
    by_state = next(c for c in group if c.name == "ozon-jobs-by-state")
    assert by_state.path == "/admin/jobs/jobsControl/ozon/jobs-by-state"


def test_jobs_group_segment_used_in_path() -> None:
    """`segment` подставляется в путь дословно (dataLoader, не dl)."""
    group = _jobs_group("dl-jobs", "dataLoader")
    for spec in group:
        assert "/jobsControl/dataLoader/" in spec.path


def test_jobs_groups_present_in_catalog() -> None:
    """Все три jobs-группы (wb/ozon/dl) развёрнуты в каталог — 15 команд."""
    for prefix in ("wb-jobs", "ozon-jobs", "dl-jobs"):
        present = [c.name for c in COMMANDS if c.name.startswith(f"{prefix}-")]
        assert len(present) == 5, prefix


# ──────────────────────────────────────────────────────────────────────────────
# Валидаторы _validate_spec / _validate_all (включая error-пути)
# ──────────────────────────────────────────────────────────────────────────────


def test_validate_spec_accepts_valid() -> None:
    """Валидный спек проходит `_validate_spec` без исключения."""
    spec = CommandSpec(
        name="ok",
        method="GET",
        path="/admin/client/:clientId/ss/:spreadsheetId",
        summary="ok",
        path_params=(CLIENT_ID, SS_ID),
    )
    _validate_spec(spec)


def test_validate_spec_missing_path_param_raises() -> None:
    """Placeholder в пути без объявленного path_param → ValueError."""
    bad = CommandSpec(name="bad", method="GET", path="/a/:foo", summary="s")
    with pytest.raises(ValueError, match="path placeholders"):
        _validate_spec(bad)


def test_validate_spec_extra_declared_param_raises() -> None:
    """Объявленный path_param без placeholder'а в пути → ValueError."""
    bad = CommandSpec(
        name="bad",
        method="GET",
        path="/a",
        summary="s",
        path_params=(PathParam("foo", "d"),),
    )
    with pytest.raises(ValueError, match="path placeholders"):
        _validate_spec(bad)


def test_validate_spec_param_order_mismatch_raises() -> None:
    """Порядок path_params не совпадает с порядком placeholder'ов → ValueError."""
    bad = CommandSpec(
        name="bad",
        method="GET",
        path="/a/:foo/:bar",
        summary="s",
        path_params=(PathParam("bar", "d"), PathParam("foo", "d")),
    )
    with pytest.raises(ValueError, match="path placeholders"):
        _validate_spec(bad)


def test_validate_spec_duplicate_body_fields_raises() -> None:
    """Повтор имени body-поля внутри спека → ValueError."""
    bad = CommandSpec(
        name="bad",
        method="POST",
        path="/a",
        summary="s",
        body_fields=(BodyField("k", "string", "d"), BodyField("k", "number", "d2")),
    )
    with pytest.raises(ValueError, match="duplicate body_fields"):
        _validate_spec(bad)


def test_validate_all_passes_on_real_catalog() -> None:
    """Реальный каталог валиден — `_validate_all` не бросает (повторно после import)."""
    _validate_all()


def test_validate_all_duplicate_names_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """`_validate_all` ловит дубль имени команды в каталоге."""
    dup = CommandSpec(name="dup", method="GET", path="/x", summary="s")
    monkeypatch.setattr(spec_mod, "COMMANDS", (dup, dup))
    with pytest.raises(ValueError, match="duplicate command names"):
        _validate_all()


# ──────────────────────────────────────────────────────────────────────────────
# Дефолты и иммутабельность dataclass'ов
# ──────────────────────────────────────────────────────────────────────────────


def test_body_field_required_default_false() -> None:
    """`required` у BodyField по умолчанию False."""
    assert BodyField("x", "string", "d").required is False
    assert BodyField("x", "string", "d", required=True).required is True


def test_command_spec_defaults() -> None:
    """Минимальный CommandSpec: пустые кортежи параметров и выключенные флаги."""
    spec = CommandSpec(name="m", method="GET", path="/m", summary="s")
    assert spec.path_params == ()
    assert spec.body_fields == ()
    assert spec.accepts_raw_body is False
    assert spec.no_auth is False
    assert spec.token_only is False
    assert spec.description is None


def test_command_spec_is_frozen() -> None:
    """CommandSpec заморожен — присваивание полю падает в рантайме."""
    spec = COMMANDS[0]
    # Имя атрибута через переменную: статически не резолвится в read-only поле
    # (иначе pyright/ruff видят попытку записи), но runtime ловит FrozenInstanceError.
    attr_name = "name"
    with pytest.raises(FrozenInstanceError):
        setattr(spec, attr_name, "mutated")


def test_all_path_param_names_returns_names_tuple() -> None:
    """`all_path_param_names` возвращает кортеж имён в порядке объявления."""
    spec = COMMANDS_BY_NAME["get-wb-cabinet-module"]
    assert all_path_param_names(spec) == ("clientId", "sid", "module")
