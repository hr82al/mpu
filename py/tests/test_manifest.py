"""Слепок дерева команд — контракт для внешнего потребителя.

Проверяется состав записей, а не тексты: тексты берутся из самих команд и
меняются вместе с ними.
"""

from __future__ import annotations

from typing import Any

import pytest

from mpu.commands.manifest import MANIFEST_VERSION, build_manifest


@pytest.fixture(scope="module")
def manifest() -> dict[str, Any]:
    return build_manifest()


@pytest.fixture(scope="module")
def by_path(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {" ".join(node["path"]): node for node in manifest["commands"]}


def test_version_and_shape(manifest: dict[str, Any]) -> None:
    assert manifest["manifestVersion"] == MANIFEST_VERSION
    assert manifest["mpuVersion"]
    assert manifest["commands"]


def test_group_carries_own_texts(by_path: dict[str, dict[str, Any]]) -> None:
    """Составное имя — запись со своей однострокой, а не дырка между листьями."""
    group = by_path["xlsx alias"]
    assert group["group"] is True
    assert group["summary"]


def test_leaf_is_not_marked_group(by_path: dict[str, dict[str, Any]]) -> None:
    assert "group" not in by_path["xlsx alias ls"]


def test_root_is_not_a_record(by_path: dict[str, dict[str, Any]]) -> None:
    """У корня пустой путь: описание CLI командой дерева не является."""
    assert "" not in by_path


def test_every_node_has_summary(manifest: dict[str, Any]) -> None:
    missing = [" ".join(n["path"]) for n in manifest["commands"] if not n.get("summary")]
    assert missing == []
