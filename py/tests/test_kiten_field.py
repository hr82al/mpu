"""Тесты `mpu kiten field` — кастомные поля карточки.

Общие двойники — `tests/kiten_fakes.py` (подключён плагином в conftest).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from kiten_fakes import FakeKaitenClient, card_detail, card_links, install_client, runner, seed_link
from mpu.commands.kiten import (
    app,
)
from mpu.lib import kaiten_links
from mpu.lib.kaiten import (
    KaitenFile,
)

# ── field set / ls / update / rm ────────────────────────────────────────────────


def test_field_set(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "set", "100", "mr", "https://mr/1"])
    assert res.exit_code == 0, res.stderr
    assert "ok: mr → https://mr/1" in res.output
    assert fake.props_set == [(100, "id_398965", "https://mr/1")]
    assert card_links()[0].value == "https://mr/1"


def test_field_set_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    fake = FakeKaitenClient(fail={"set_card_property"})
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "set", "100", "mr", "https://mr/1"])
    assert res.exit_code == 1
    assert "field set: kaiten error" in res.stderr


def test_field_artefact_set_uploads_to_property(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    md = tmp_path / "67531635-slug.md"
    md.write_text("# 67531635 test = ok\n", encoding="utf-8")
    res = runner.invoke(app, ["field", "artefact", "set", "67531635", str(md)])
    assert res.exit_code == 0, res.stderr
    assert "ok: артефакт 67531635-slug.md" in res.output
    assert fake.uploaded_files == [
        {
            "card_id": 67531635,
            "property_id": kaiten_links.ARTEFACT_PROPERTY_ID,
            "filename": "67531635-slug.md",
            "content": b"# 67531635 test = ok\n",
        }
    ]


def test_field_artefact_set_rejects_non_md(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    txt = tmp_path / "report.txt"
    txt.write_text("x", encoding="utf-8")
    res = runner.invoke(app, ["field", "artefact", "set", "100", str(txt)])
    assert res.exit_code != 0
    assert "должен быть .md" in res.stderr
    assert fake.uploaded_files == []  # guard срабатывает до сети


def test_field_artefact_set_error_exits_1(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake = FakeKaitenClient(fail={"upload_property_file"})
    install_client(monkeypatch, fake)
    md = tmp_path / "a.md"
    md.write_text("# A", encoding="utf-8")
    res = runner.invoke(app, ["field", "artefact", "set", "100", str(md)])
    assert res.exit_code == 1
    assert "field artefact set: kaiten error" in res.stderr


def _artefact_file(file_id: int, name: str, *, in_field: bool) -> KaitenFile:
    return KaitenFile(
        id=file_id,
        name=name,
        custom_property_id=kaiten_links.ARTEFACT_PROPERTY_ID if in_field else None,
    )


def test_field_artefact_rm_deletes_only_field_files(monkeypatch: pytest.MonkeyPatch) -> None:
    detail = card_detail(
        card_id=100,
        files=[
            _artefact_file(1, "old-artefact.md", in_field=True),
            _artefact_file(2, "изображение.png", in_field=False),  # card-level, не трогать
        ],
    )
    fake = FakeKaitenClient(details=[detail])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "artefact", "rm", "100"])
    assert res.exit_code == 0, res.stderr
    assert "удалено из «AI-артефакт»: old-artefact.md" in res.output
    assert fake.deleted_files == [(100, 1)]  # только файл поля


def test_field_artefact_rm_empty_field(monkeypatch: pytest.MonkeyPatch) -> None:
    detail = card_detail(card_id=100, files=[_artefact_file(2, "изображение.png", in_field=False)])
    fake = FakeKaitenClient(details=[detail])
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "artefact", "rm", "100"])
    assert res.exit_code == 0, res.stderr
    assert "уже пусто" in res.output
    assert fake.deleted_files == []


def test_field_artefact_rm_error_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    detail = card_detail(card_id=100, files=[_artefact_file(1, "a.md", in_field=True)])
    fake = FakeKaitenClient(details=[detail], fail={"delete_card_file"})
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "artefact", "rm", "100"])
    assert res.exit_code == 1
    assert "field artefact rm: kaiten error" in res.stderr


def test_field_ls_empty(db_path: Path) -> None:
    res = runner.invoke(app, ["field", "ls"])
    assert res.exit_code == 0, res.stderr
    assert "(пусто)" in res.output


def test_field_ls_json(db_path: Path) -> None:
    seed_link(100, "mr", "https://mr/1")
    res = runner.invoke(app, ["field", "ls", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert payload[0]["card_id"] == 100
    assert payload[0]["field"] == "mr"
    assert payload[0]["value"] == "https://mr/1"


def test_field_ls_filter_by_card_and_kind(db_path: Path) -> None:
    seed_link(100, "mr", "https://mr/1")
    seed_link(200, "done", "сделано")
    res = runner.invoke(app, ["field", "ls", "--card", "100", "--kind", "mr", "--json"])
    assert res.exit_code == 0, res.stderr
    payload: list[dict[str, Any]] = json.loads(res.output)
    assert [link["card_id"] for link in payload] == [100]


def test_field_update(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    link = seed_link(100, "mr", "https://old")
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "update", str(link.id), "https://new"])
    assert res.exit_code == 0, res.stderr
    assert f"ok: #{link.id} mr → https://new" in res.output
    assert fake.props_set == [(100, "id_398965", "https://new")]


def test_field_update_missing_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(monkeypatch, FakeKaitenClient())
    res = runner.invoke(app, ["field", "update", "999", "x"])
    assert res.exit_code == 1
    assert "записи #999 нет" in res.stderr


def test_field_rm_resyncs_to_previous(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    seed_link(100, "mr", "https://v1")
    link2 = seed_link(100, "mr", "https://v2")
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "rm", str(link2.id)])
    assert res.exit_code == 0, res.stderr
    assert "удалена" in res.output
    assert fake.props_set == [(100, "id_398965", "https://v1")]  # откат к предыдущей записи


def test_field_rm_last_clears_field(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    link = seed_link(100, "mr", "https://only")
    fake = FakeKaitenClient()
    install_client(monkeypatch, fake)
    res = runner.invoke(app, ["field", "rm", str(link.id)])
    assert res.exit_code == 0, res.stderr
    assert "(очищено)" in res.output
    assert fake.props_set == [(100, "id_398965", None)]


def test_field_rm_missing_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    install_client(monkeypatch, FakeKaitenClient())
    res = runner.invoke(app, ["field", "rm", "999"])
    assert res.exit_code == 1
    assert "записи #999 нет" in res.stderr


def test_field_update_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    link = seed_link(100, "mr", "https://old")
    install_client(monkeypatch, FakeKaitenClient(fail={"set_card_property"}))
    res = runner.invoke(app, ["field", "update", str(link.id), "https://new"])
    assert res.exit_code == 1
    assert "field update: kaiten error" in res.stderr


def test_field_rm_error_exits_1(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    link = seed_link(100, "mr", "https://only")
    install_client(monkeypatch, FakeKaitenClient(fail={"set_card_property"}))
    res = runner.invoke(app, ["field", "rm", str(link.id)])
    assert res.exit_code == 1
    assert "field rm: kaiten error" in res.stderr
