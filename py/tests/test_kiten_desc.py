"""Тесты `mpu kiten desc` — замена описания карточки.

Общие двойники — `tests/kiten_fakes.py` (подключён плагином в conftest).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from kiten_fakes import FakeKaitenClient, install_client, runner
from mpu.commands.kiten import app


def test_desc_message_replaces_description(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["desc", "100", "-m", "# Заголовок\n\n- пункт"])
    assert res.exit_code == 0, res.stderr
    assert fake.descriptions_set == [(100, "# Заголовок\n\n- пункт")]
    assert "ok: описание заменено (20 символов)" in res.output
    assert "https://btlz.kaiten.ru/100" in res.output


def test_desc_body_file_sent_verbatim(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Markdown уходит в API как есть — команда ничего не экранирует (в этом её смысл)."""
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    body = tmp_path / "desc.md"
    body.write_text("## План\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", encoding="utf-8")
    res = runner.invoke(app, ["desc", "https://btlz.kaiten.ru/68267471", "-F", str(body)])
    assert res.exit_code == 0, res.stderr
    assert fake.descriptions_set == [(68267471, "## План\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")]


def test_desc_requires_exactly_one_source(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["desc", "100"])
    assert res.exit_code == 2  # BadParameter: ни -m, ни -F
    assert fake.descriptions_set == []


def test_desc_api_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeKaitenClient(fail={"update_card_description"})
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["desc", "100", "-m", "текст"])
    assert res.exit_code == 1
    assert "desc: kaiten error" in res.stderr
