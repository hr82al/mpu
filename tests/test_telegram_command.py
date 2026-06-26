"""Тесты CLI-обёртки `mpu telegram` (`commands/telegram.py`).

Драйв через typer CliRunner; вся async I/O-граница telethon (send/ls/search) и
чистые resolve_chat/parse_chat_target замокированы у источника `mpu.lib.telegram`,
а `TgConfig.from_env` / `KaitenClient.from_env` / журнал `kaiten_card_moves` — фейками.
Проверяем happy/error/empty пути + что `send` НЕ вызывается на `--dry-run`.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import cast

import pytest
from typer.testing import CliRunner

from mpu.commands import telegram as telegram_cmd
from mpu.lib import env, kaiten_links, kiten_status, store, telegram
from mpu.lib.kaiten import (
    KaitenAPIError,
    KaitenCard,
    KaitenClient,
    KaitenColumn,
    KaitenLocationChange,
    KaitenUser,
)

runner = CliRunner()

ME_ID = 555


# ── Фейк I/O-границы telethon (mpu.lib.telegram) ─────────────────────────────


class _FakeTg:
    """Recorder + async-стабы для telethon-I/O. Чистые resolve/parse тоже подменены,
    чтобы детерминированно фиксировать адресата и то, что именно ушло в `send`."""

    def __init__(self) -> None:
        self.resolve_calls: list[tuple[str | None, str | None]] = []
        self.parse_calls: list[str] = []
        self.send_calls: list[tuple[str | int, str, str | None]] = []
        self.send_file_calls: list[tuple[str | int, list[str], str | None, str | None]] = []
        self.list_calls: list[int] = []
        self.search_entities_calls: list[tuple[str, int]] = []
        self.search_messages_calls: list[tuple[str, str | int | None, str | int | None, int]] = []
        self.dialogs: list[telegram.TgDialog] = []
        self.messages: list[telegram.TgMessage] = []
        self.resolved = "RESOLVED"
        self.target: str | int = "target-chat"
        self.sent = telegram.TgSentMessage(id=99, chat_id=-100500, date="2026-06-25T10:00:00+00:00")
        self.send_error: BaseException | None = None
        self.list_error: BaseException | None = None
        self.search_error: BaseException | None = None

    def resolve_chat(self, cli_chat: str | None, env_chat: str | None) -> str:
        self.resolve_calls.append((cli_chat, env_chat))
        return self.resolved

    def parse_chat_target(self, raw: str) -> str | int:
        self.parse_calls.append(raw)
        return self.target

    async def send_message(
        self,
        cfg: telegram.TgConfig,
        target: str | int,
        text: str,
        *,
        parse_mode: str | None = None,
    ) -> telegram.TgSentMessage:
        _ = cfg
        self.send_calls.append((target, text, parse_mode))
        if self.send_error is not None:
            raise self.send_error
        return self.sent

    async def send_file(
        self,
        cfg: telegram.TgConfig,
        target: str | int,
        files: list[str],
        *,
        caption: str | None = None,
        parse_mode: str | None = None,
    ) -> telegram.TgSentMessage:
        _ = cfg
        self.send_file_calls.append((target, files, caption, parse_mode))
        if self.send_error is not None:
            raise self.send_error
        return self.sent

    async def list_dialogs(self, cfg: telegram.TgConfig, limit: int) -> list[telegram.TgDialog]:
        _ = cfg
        self.list_calls.append(limit)
        if self.list_error is not None:
            raise self.list_error
        return self.dialogs

    async def search_entities(
        self, cfg: telegram.TgConfig, query: str, limit: int
    ) -> list[telegram.TgDialog]:
        _ = cfg
        self.search_entities_calls.append((query, limit))
        if self.list_error is not None:
            raise self.list_error
        return self.dialogs

    async def search_messages(
        self,
        cfg: telegram.TgConfig,
        query: str,
        *,
        chat: str | int | None,
        from_user: str | int | None,
        limit: int,
    ) -> list[telegram.TgMessage]:
        _ = cfg
        self.search_messages_calls.append((query, chat, from_user, limit))
        if self.search_error is not None:
            raise self.search_error
        return self.messages


def _fixed_config() -> telegram.TgConfig:
    return telegram.TgConfig(api_id=1, api_hash="h", session="s")


def _raise_from_env() -> telegram.TgConfig:
    raise telegram.TgError("telegram: TELEGRAM_API_ID не задан")


def _env_get(values: dict[str, str | None]) -> Callable[[str, str | None], str | None]:
    def _get(name: str, default: str | None = None) -> str | None:
        return values.get(name, default)

    return _get


@pytest.fixture
def fake_tg(monkeypatch: pytest.MonkeyPatch) -> _FakeTg:
    """Подменить весь telethon-I/O + TgConfig.from_env + env.get на детерминированные фейки."""
    fake = _FakeTg()
    monkeypatch.setattr(telegram.TgConfig, "from_env", staticmethod(_fixed_config))
    monkeypatch.setattr(telegram, "resolve_chat", fake.resolve_chat)
    monkeypatch.setattr(telegram, "parse_chat_target", fake.parse_chat_target)
    monkeypatch.setattr(telegram, "send_message", fake.send_message)
    monkeypatch.setattr(telegram, "send_file", fake.send_file)
    monkeypatch.setattr(telegram, "list_dialogs", fake.list_dialogs)
    monkeypatch.setattr(telegram, "search_entities", fake.search_entities)
    monkeypatch.setattr(telegram, "search_messages", fake.search_messages)
    monkeypatch.setattr(env, "get", _env_get({"TELEGRAM_DEFAULT_CHAT": "@team"}))
    return fake


@pytest.fixture
def status_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """tmp-путь к `mpu.db`, на который смотрит store (журнал перемещений)."""
    db = tmp_path / "mpu.db"
    monkeypatch.setattr(store, "DB_PATH", db)
    return db


def _seed_move(db: Path, *, card_id: int, title: str, url: str | None, to_column: str) -> None:
    """Записать одно перемещение в журнал внутри окна «сегодня» (МСК)."""
    since, _until = kiten_status.today_epoch_window()
    with store.store(db) as conn:
        store.bootstrap(conn)
        kaiten_links.record_move(
            conn, card_id, to_column=to_column, title=title, url=url, now=since + 60
        )


# ── send ─────────────────────────────────────────────────────────────────────


def test_send_explicit_chat(fake_tg: _FakeTg) -> None:
    result = runner.invoke(telegram_cmd.app, ["send", "привет", "--chat", "me"])
    assert result.exit_code == 0, result.output
    # --chat имеет приоритет: первый аргумент resolve_chat = "me".
    assert fake_tg.resolve_calls == [("me", "@team")]
    assert fake_tg.send_calls == [("target-chat", "привет", None)]
    assert json.loads(result.output) == {
        "id": 99,
        "chat_id": -100500,
        "date": "2026-06-25T10:00:00+00:00",
    }


def test_send_default_chat(fake_tg: _FakeTg) -> None:
    result = runner.invoke(telegram_cmd.app, ["send", "привет"])
    assert result.exit_code == 0, result.output
    # без --chat адресат берётся из TELEGRAM_DEFAULT_CHAT (env), cli-аргумент None.
    assert fake_tg.resolve_calls == [(None, "@team")]
    assert len(fake_tg.send_calls) == 1


def test_send_md_enables_markdown(fake_tg: _FakeTg) -> None:
    result = runner.invoke(telegram_cmd.app, ["send", "[x](u)", "--chat", "me", "--md"])
    assert result.exit_code == 0, result.output
    assert fake_tg.send_calls[0][2] == "md"


def test_send_no_md_parse_mode_none(fake_tg: _FakeTg) -> None:
    result = runner.invoke(telegram_cmd.app, ["send", "обычный текст", "--chat", "me"])
    assert result.exit_code == 0, result.output
    assert fake_tg.send_calls[0][2] is None


def test_send_reads_stdin(fake_tg: _FakeTg) -> None:
    result = runner.invoke(telegram_cmd.app, ["send", "-", "--chat", "me"], input="из stdin\n")
    assert result.exit_code == 0, result.output
    assert "из stdin" in fake_tg.send_calls[0][1]


def test_send_empty_text_fails_without_io(fake_tg: _FakeTg) -> None:
    result = runner.invoke(telegram_cmd.app, ["send", "   ", "--chat", "me"])
    assert result.exit_code == 1
    assert "пустой текст" in result.output
    assert fake_tg.send_calls == []  # I/O не тронуто


def test_send_empty_stdin_fails(fake_tg: _FakeTg) -> None:
    result = runner.invoke(telegram_cmd.app, ["send", "-", "--chat", "me"], input="")
    assert result.exit_code == 1
    assert fake_tg.send_calls == []


def test_send_not_authorized_error(fake_tg: _FakeTg) -> None:
    fake_tg.send_error = telegram.TgNotAuthorizedError("telegram: не авторизован; запусти init")
    result = runner.invoke(telegram_cmd.app, ["send", "привет", "--chat", "me"])
    assert result.exit_code == 1
    assert "не авторизован" in result.output


def test_send_tg_error(fake_tg: _FakeTg) -> None:
    fake_tg.send_error = telegram.TgError("telegram: RPC error: boom")
    result = runner.invoke(telegram_cmd.app, ["send", "привет", "--chat", "me"])
    assert result.exit_code == 1
    assert "RPC error" in result.output


def test_send_from_env_error(fake_tg: _FakeTg, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(telegram.TgConfig, "from_env", staticmethod(_raise_from_env))
    result = runner.invoke(telegram_cmd.app, ["send", "привет", "--chat", "me"])
    assert result.exit_code == 1
    assert "TELEGRAM_API_ID" in result.output
    assert fake_tg.send_calls == []


def test_send_with_file(fake_tg: _FakeTg, tmp_path: Path) -> None:
    f = tmp_path / "diff.zip"
    f.write_bytes(b"zip")
    result = runner.invoke(telegram_cmd.app, ["send", "url", "--chat", "me", "-f", str(f)])
    assert result.exit_code == 0, result.output
    # текст ушёл подписью, путь — в send_file; текстовый send не дёргался.
    assert fake_tg.send_file_calls == [("target-chat", [str(f)], "url", None)]
    assert fake_tg.send_calls == []
    assert json.loads(result.output) == {
        "id": 99,
        "chat_id": -100500,
        "date": "2026-06-25T10:00:00+00:00",
    }


def test_send_multiple_files_with_md(fake_tg: _FakeTg, tmp_path: Path) -> None:
    a = tmp_path / "a.txt"
    b = tmp_path / "b.txt"
    a.write_text("a")
    b.write_text("b")
    result = runner.invoke(
        telegram_cmd.app, ["send", "cap", "--chat", "me", "--md", "-f", str(a), "-f", str(b)]
    )
    assert result.exit_code == 0, result.output
    assert fake_tg.send_file_calls == [("target-chat", [str(a), str(b)], "cap", "md")]


def test_send_file_empty_caption(fake_tg: _FakeTg, tmp_path: Path) -> None:
    """Пустой текст при наличии файла допустим → подпись None (не падаем на «пустой текст»)."""
    f = tmp_path / "x.zip"
    f.write_bytes(b"x")
    result = runner.invoke(telegram_cmd.app, ["send", "", "-f", str(f)])
    assert result.exit_code == 0, result.output
    assert fake_tg.send_file_calls == [("target-chat", [str(f)], None, None)]


def test_send_missing_file_fails_without_io(fake_tg: _FakeTg, tmp_path: Path) -> None:
    missing = tmp_path / "nope.zip"
    result = runner.invoke(telegram_cmd.app, ["send", "url", "-f", str(missing)])
    assert result.exit_code != 0
    assert fake_tg.send_file_calls == []  # валидация до сети
    assert fake_tg.send_calls == []


# ── ls ───────────────────────────────────────────────────────────────────────


def test_ls_dialogs_json(fake_tg: _FakeTg) -> None:
    fake_tg.dialogs = [
        telegram.TgDialog(id=42, title="Иван Изран", kind="user", username="izran"),
        telegram.TgDialog(id=-1001234, title="Dev chat", kind="channel", username=None),
    ]
    result = runner.invoke(telegram_cmd.app, ["ls"])
    assert result.exit_code == 0, result.output
    assert fake_tg.list_calls == [50]  # дефолтный лимит
    assert fake_tg.search_entities_calls == []  # без запроса — диалоги, не поиск
    assert json.loads(result.output) == [telegram.dialog_to_dict(d) for d in fake_tg.dialogs]


def test_ls_query_uses_search(fake_tg: _FakeTg) -> None:
    fake_tg.dialogs = [telegram.TgDialog(id=42, title="Иван", kind="user", username="izran")]
    result = runner.invoke(telegram_cmd.app, ["ls", "Иван", "--limit", "5"])
    assert result.exit_code == 0, result.output
    assert fake_tg.search_entities_calls == [("Иван", 5)]
    assert fake_tg.list_calls == []  # с запросом list_dialogs не дёргается


def test_ls_empty_json(fake_tg: _FakeTg) -> None:
    result = runner.invoke(telegram_cmd.app, ["ls"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == []


def test_ls_table(fake_tg: _FakeTg) -> None:
    fake_tg.dialogs = [
        telegram.TgDialog(id=42, title="Иван Изран", kind="user", username="izran"),
        telegram.TgDialog(id=-1001234, title="Dev chat", kind="channel", username=None),
    ]
    result = runner.invoke(telegram_cmd.app, ["ls", "--table"])
    assert result.exit_code == 0, result.output
    assert "izran" in result.output
    assert "(2 dialogs)" in result.output


def test_ls_table_empty(fake_tg: _FakeTg) -> None:
    result = runner.invoke(telegram_cmd.app, ["ls", "--table"])
    assert result.exit_code == 0, result.output
    assert "(нет диалогов)" in result.output


def test_ls_error(fake_tg: _FakeTg) -> None:
    fake_tg.list_error = telegram.TgError("telegram: rate-limit, подожди 30s")
    result = runner.invoke(telegram_cmd.app, ["ls"])
    assert result.exit_code == 1
    assert "rate-limit" in result.output


# ── search ───────────────────────────────────────────────────────────────────


def _msg() -> telegram.TgMessage:
    return telegram.TgMessage(
        id=7,
        chat_id=-1001234,
        chat_title="Dev chat",
        sender="Иван",
        date="2026-06-18T10:00:00+00:00",
        text="залил не в ту ветку",
        link="https://t.me/c/1234/7",
    )


def test_search_global_json(fake_tg: _FakeTg) -> None:
    fake_tg.messages = [_msg()]
    result = runner.invoke(telegram_cmd.app, ["search", "ветку"])
    assert result.exit_code == 0, result.output
    # глобально: и chat, и from_user — None.
    assert fake_tg.search_messages_calls == [("ветку", None, None, 50)]
    assert json.loads(result.output) == [telegram.message_to_dict(m) for m in fake_tg.messages]


def test_search_with_chat(fake_tg: _FakeTg) -> None:
    fake_tg.messages = [_msg()]
    result = runner.invoke(telegram_cmd.app, ["search", "ветку", "--chat", "me", "--limit", "10"])
    assert result.exit_code == 0, result.output
    query, chat, from_user, limit = fake_tg.search_messages_calls[0]
    assert (query, chat, from_user, limit) == ("ветку", "target-chat", None, 10)


def test_search_with_from(fake_tg: _FakeTg) -> None:
    fake_tg.messages = [_msg()]
    result = runner.invoke(telegram_cmd.app, ["search", "ветку", "--from", "ivan"])
    assert result.exit_code == 0, result.output
    query, chat, from_user, _limit = fake_tg.search_messages_calls[0]
    assert (query, chat, from_user) == ("ветку", None, "target-chat")


def test_search_empty_query_with_chat(fake_tg: _FakeTg) -> None:
    fake_tg.messages = [_msg()]
    result = runner.invoke(telegram_cmd.app, ["search", "--chat", "me"])
    assert result.exit_code == 0, result.output
    query, chat, _from, _limit = fake_tg.search_messages_calls[0]
    assert query == ""
    assert chat == "target-chat"


def test_search_table(fake_tg: _FakeTg) -> None:
    fake_tg.messages = [_msg()]
    result = runner.invoke(telegram_cmd.app, ["search", "ветку", "--table"])
    assert result.exit_code == 0, result.output
    assert "Иван" in result.output
    assert "(1 messages)" in result.output


def test_search_table_empty(fake_tg: _FakeTg) -> None:
    result = runner.invoke(telegram_cmd.app, ["search", "ветку", "--table"])
    assert result.exit_code == 0, result.output
    assert "(ничего не найдено)" in result.output


def test_search_error(fake_tg: _FakeTg) -> None:
    fake_tg.search_error = telegram.TgError(
        "telegram: нужен текст запроса или --chat (пустой глобальный поиск запрещён)"
    )
    result = runner.invoke(telegram_cmd.app, ["search", "ветку"])
    assert result.exit_code == 1
    assert "пустой глобальный поиск запрещён" in result.output


# ── status ───────────────────────────────────────────────────────────────────


def test_status_send_local_only(fake_tg: _FakeTg, status_db: Path) -> None:
    _seed_move(
        status_db,
        card_id=111,
        title="Моя карточка",
        url="https://btlz.kaiten.ru/111",
        to_column="Готово",
    )
    result = runner.invoke(telegram_cmd.app, ["status", "--no-live"])
    assert result.exit_code == 0, result.output
    # отправлено markdown'ом в дефолтный чат, ровно один вызов.
    assert fake_tg.resolve_calls == [(None, "@team")]
    assert len(fake_tg.send_calls) == 1
    target, text, parse_mode = fake_tg.send_calls[0]
    assert target == "target-chat"
    assert parse_mode == "md"
    assert "[Моя карточка](https://btlz.kaiten.ru/111)" in text
    assert json.loads(result.output)["id"] == 99


def test_status_dry_run_does_not_send(fake_tg: _FakeTg, status_db: Path) -> None:
    _seed_move(
        status_db,
        card_id=222,
        title="Карточка-2",
        url="https://btlz.kaiten.ru/222",
        to_column="Готово",
    )
    result = runner.invoke(telegram_cmd.app, ["status", "--dry-run", "--no-live"])
    assert result.exit_code == 0, result.output
    assert fake_tg.send_calls == []  # dry-run НЕ отправляет
    assert "[Карточка-2](https://btlz.kaiten.ru/222)" in result.output
    assert "✅" in result.output


def test_status_dry_run_url_fallback(fake_tg: _FakeTg, status_db: Path) -> None:
    # url не сохранён в журнале → собирается из base + card_id (card_url).
    _seed_move(status_db, card_id=333, title="Без ссылки", url=None, to_column="Разработка")
    result = runner.invoke(telegram_cmd.app, ["status", "--dry-run", "--no-live"])
    assert result.exit_code == 0, result.output
    assert "(https://btlz.kaiten.ru/333)" in result.output


def test_status_empty_journal_dry_run(fake_tg: _FakeTg, status_db: Path) -> None:
    _ = status_db  # пустой журнал
    result = runner.invoke(telegram_cmd.app, ["status", "--dry-run", "--no-live"])
    assert result.exit_code == 0, result.output
    assert "Сегодня перемещений не было" in result.output
    assert fake_tg.send_calls == []


def test_status_truncates_long_message(fake_tg: _FakeTg, status_db: Path) -> None:
    # Журнал длиннее лимита Telegram (4096) → текст обрезается с маркером перед отправкой.
    since, _until = kiten_status.today_epoch_window()
    long_title = "Очень длинный заголовок карточки " * 8
    with store.store(status_db) as conn:
        store.bootstrap(conn)
        for i in range(40):
            kaiten_links.record_move(
                conn,
                1000 + i,
                to_column="Готово",
                title=f"{i} {long_title}",
                url="https://btlz.kaiten.ru/x",
                now=since + 60 + i,
            )
    result = runner.invoke(telegram_cmd.app, ["status", "--no-live"])
    assert result.exit_code == 0, result.output
    sent_text = fake_tg.send_calls[0][1]
    assert len(sent_text) <= telegram_cmd._TELEGRAM_MAX  # pyright: ignore[reportPrivateUsage]
    assert sent_text.endswith("…(обрезано)")


def test_status_send_error(fake_tg: _FakeTg, status_db: Path) -> None:
    _seed_move(status_db, card_id=444, title="X", url="https://btlz.kaiten.ru/444", to_column="QA")
    fake_tg.send_error = telegram.TgNotAuthorizedError("telegram: не авторизован; запусти init")
    result = runner.invoke(telegram_cmd.app, ["status", "--no-live"])
    assert result.exit_code == 1
    assert "не авторизован" in result.output


def _live_client(*, fail: KaitenAPIError | None = None) -> KaitenClient:
    """Фейк KaitenClient для `_live_move_entries`: один валидный мой ход сегодня (A),
    один чужой (B → отбрасывается), один без колонки (C → «—»)."""
    iso_from, _iso_to = kiten_status.today_iso_window()
    cards = [
        KaitenCard(900, "Live A", 3, 1, None, iso_from, 7, 30, "https://btlz.kaiten.ru/900"),
        KaitenCard(901, "Live B", 2, 1, None, iso_from, 7, 20, "https://btlz.kaiten.ru/901"),
        KaitenCard(902, "Live C", 2, 1, None, iso_from, 7, None, "https://btlz.kaiten.ru/902"),
    ]
    columns = [
        KaitenColumn(id=30, board_id=7, title="Готово", sort_order=3.0),
        KaitenColumn(id=20, board_id=7, title="Разработка", sort_order=2.0),
    ]
    history: dict[int, list[KaitenLocationChange]] = {
        900: [KaitenLocationChange(900, 30, None, ME_ID, "Me", iso_from)],
        901: [KaitenLocationChange(901, 20, None, 999, "Other", iso_from)],
        902: [KaitenLocationChange(902, None, None, ME_ID, "Me", iso_from)],
    }
    return cast("KaitenClient", _FakeLiveClient(cards, columns, history, fail=fail))


class _FakeLiveClient:
    def __init__(
        self,
        cards: list[KaitenCard],
        columns: list[KaitenColumn],
        history: dict[int, list[KaitenLocationChange]],
        *,
        fail: KaitenAPIError | None,
    ) -> None:
        self._cards = cards
        self._columns = columns
        self._history = history
        self._fail = fail

    def current_user(self) -> KaitenUser:
        if self._fail is not None:
            raise self._fail
        return KaitenUser(id=ME_ID, full_name="Me", username="me", email="m@x")

    def list_cards(
        self,
        *,
        member_ids: str,
        updated_after: str | None = None,
        updated_before: str | None = None,
    ) -> list[KaitenCard]:
        _ = (member_ids, updated_after, updated_before)
        return self._cards

    def list_columns(self, board_ids: list[int]) -> list[KaitenColumn]:
        _ = board_ids
        return self._columns

    def location_history(self, card_id: int) -> list[KaitenLocationChange]:
        return self._history.get(card_id, [])


def test_status_live_enrichment_dry_run(
    fake_tg: _FakeTg, status_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = status_db  # пустой локальный журнал — все строки из Kaiten
    monkeypatch.setattr(telegram_cmd.KaitenClient, "from_env", staticmethod(lambda: _live_client()))
    result = runner.invoke(telegram_cmd.app, ["status", "--live", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert "Live A" in result.output  # мой ход сегодня
    assert "Live C" in result.output  # без колонки → «—»
    assert "Live B" not in result.output  # чужой автор отброшен
    assert "—" in result.output
    assert fake_tg.send_calls == []


def test_status_live_error_skipped(
    fake_tg: _FakeTg, status_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_move(
        status_db,
        card_id=555,
        title="Локальная",
        url="https://btlz.kaiten.ru/555",
        to_column="Готово",
    )
    boom = KaitenAPIError("GET", "/users/current", 500, "server error")
    monkeypatch.setattr(
        telegram_cmd.KaitenClient, "from_env", staticmethod(lambda: _live_client(fail=boom))
    )
    result = runner.invoke(telegram_cmd.app, ["status", "--live", "--dry-run"])
    assert result.exit_code == 0, result.output
    # live-сбой не валит команду: предупреждение в stderr + локальный журнал остаётся.
    assert "live-обогащение пропущено" in result.output
    assert "Локальная" in result.output
