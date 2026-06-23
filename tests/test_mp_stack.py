"""Тесты `mpu.lib.mp_stack` — спека и docker-обёртки core-стеков для `mpu mp-init`."""

import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

from mpu.lib import mp_stack


def _env_names(argv: list[str]) -> list[str]:
    return [Path(argv[i + 1]).name for i, a in enumerate(argv) if a == "--env-file"]


def _compose_names(argv: list[str]) -> list[str]:
    return [Path(argv[i + 1]).name for i, a in enumerate(argv) if a == "-f"]


def _stack(name: str) -> mp_stack.Stack:
    return next(s for s in mp_stack.CORE_STACKS if s.name == name)


def test_core_stacks_names_and_order() -> None:
    assert [s.name for s in mp_stack.CORE_STACKS] == [
        "mp-nats",
        "sl-0",
        "sl-1",
        "mp-nginx",
        "dt-host",
    ]


def test_build_up_argv_sl1_full(tmp_path: Path) -> None:
    (tmp_path / ".env").write_text("X=1\n")  # .env присутствует → включается
    argv = mp_stack.build_up_argv(_stack("sl-1"), tmp_path)

    assert argv[:2] == ["docker", "compose"]
    assert argv[-3:] == ["up", "-d", "--force-recreate"]
    assert "--remove-orphans" not in argv  # иначе снесёт соседние стеки проекта
    assert _env_names(argv) == [".sl-base.env", ".env", ".sl-1.env"]
    assert _compose_names(argv) == [
        "compose.sl-base.yaml",
        "compose.sl-pg.yaml",
        "compose.pgbouncer.yaml",
        "compose.sl-instance.yaml",
    ]
    # все file-аргументы — абсолютные пути под base
    for i, a in enumerate(argv):
        if a in ("--env-file", "-f"):
            assert argv[i + 1].startswith(str(tmp_path))


def test_build_up_argv_omits_missing_dotenv(tmp_path: Path) -> None:
    # .env не создаём → опциональный env пропускается (docker иначе падает на missing file)
    argv = mp_stack.build_up_argv(_stack("sl-0"), tmp_path)
    assert _env_names(argv) == [".sl-base.env", ".sl-0.env"]


def test_build_up_argv_includes_present_dotenv(tmp_path: Path) -> None:
    (tmp_path / ".env").write_text("")
    argv = mp_stack.build_up_argv(_stack("sl-0"), tmp_path)
    assert _env_names(argv) == [".sl-base.env", ".env", ".sl-0.env"]


def test_build_up_argv_dt_host(tmp_path: Path) -> None:
    argv = mp_stack.build_up_argv(_stack("dt-host"), tmp_path)
    # .sl-dt.env обязателен (не опциональный), .env отсутствует → пропущен
    assert _env_names(argv) == [".sl-base.env", ".sl-dt.env"]
    assert _compose_names(argv) == ["compose.sl-dt-host.yaml"]


def test_network_create_argv() -> None:
    assert mp_stack.network_create_argv("mp-shared-net", "178.20.0.0/16") == [
        "docker",
        "network",
        "create",
        "--driver=bridge",
        "mp-shared-net",
        "--subnet=178.20.0.0/16",
    ]


def _fake_run(returncode: int) -> Callable[..., subprocess.CompletedProcess[bytes]]:
    def _run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess[bytes](args=argv, returncode=returncode)

    return _run


def test_network_exists_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mp_stack.subprocess, "run", _fake_run(0))
    assert mp_stack.network_exists("mp-shared-net") is True


def test_network_exists_false(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mp_stack.subprocess, "run", _fake_run(1))
    assert mp_stack.network_exists("nope") is False


def test_image_exists(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mp_stack.subprocess, "run", _fake_run(0))
    assert mp_stack.image_exists("mp-back:local") is True
    monkeypatch.setattr(mp_stack.subprocess, "run", _fake_run(1))
    assert mp_stack.image_exists("mp-back:local") is False


def test_missing_images_preserves_spec_order(monkeypatch: pytest.MonkeyPatch) -> None:
    present = {"mp-pg:local"}

    def _run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        ref = argv[-1]  # `docker image inspect <ref>`
        return subprocess.CompletedProcess[bytes](args=argv, returncode=0 if ref in present else 1)

    monkeypatch.setattr(mp_stack.subprocess, "run", _run)
    assert mp_stack.missing_images() == ["mp-back:local", "mp-dt:local"]


def test_build_up_argv_appends_service_filter(tmp_path: Path) -> None:
    argv = mp_stack.build_up_argv(mp_stack.SW_BACK_DEPS, tmp_path)
    assert argv[-5:] == ["up", "-d", "--force-recreate", "pg", "redis"]
    assert _env_names(argv) == [".sw-back.base.env"]
    assert _compose_names(argv) == ["compose.sw-back.yaml"]


def test_build_local_stack_up_argv(tmp_path: Path) -> None:
    argv = mp_stack.build_local_stack_up_argv(tmp_path / "local-stack")
    assert argv[:3] == ["docker", "compose", "-f"]
    assert Path(argv[3]).name == "docker-compose.yml"
    assert argv[-3:] == ["up", "-d", "--force-recreate"]


def test_local_stack_dir_is_sibling() -> None:
    assert mp_stack.local_stack_dir(Path("/x/mp/mp-config-local")) == Path("/x/mp/local-stack")


def test_running_conflicts_filters_running(monkeypatch: pytest.MonkeyPatch) -> None:
    running = {"mp-sw-api"}

    def _cr(name: str) -> bool:
        return name in running

    monkeypatch.setattr(mp_stack, "container_running", _cr)
    assert mp_stack.running_conflicts(("mp-sw-api", "nextjs-dev", "mp-sl-front-dev")) == [
        "mp-sw-api"
    ]


def test_stop_containers_argv() -> None:
    assert mp_stack.stop_containers_argv(["a", "b"]) == ["docker", "stop", "a", "b"]


def test_missing_web_images(monkeypatch: pytest.MonkeyPatch) -> None:
    def _no_img(ref: str) -> bool:
        return False

    monkeypatch.setattr(mp_stack, "image_exists", _no_img)
    assert mp_stack.missing_web_images() == ["sl-front-dev:local"]
