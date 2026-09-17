/**
 * DDL кэш-БД (`docs/specs/platform/store.md`). Схема заморожена до вывода
 * Python-реализации из эксплуатации: тот же файл `~/.config/mpu/mpu.db`
 * читает и пишет она. Эталон — фикстура канала
 * `docs/specs/fixtures/platform/store/schema.sql` (снята с живого
 * bootstrap); копия лежит в `testdata/` и сверяется контрактным тестом,
 * поэтому расхождение операторов с эталоном ловится тестом, а не глазами.
 *
 * `IF NOT EXISTS` даёт идемпотентность и в `sqlite_master` не попадает —
 * SQLite хранит текст оператора без этой вставки, ровно как в эталоне.
 * Таблица `sqlite_sequence` в списке отсутствует намеренно: её заводит
 * сам SQLite при первой таблице с `AUTOINCREMENT`.
 */

/** Операторы идемпотентного bootstrap: порядок — таблицы, затем индексы. */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cache (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS client_moves (
        client_id INTEGER PRIMARY KEY,
        source    TEXT NOT NULL,
        target    TEXT NOT NULL,
        moved_at  INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS kaiten_boards (
        id            INTEGER PRIMARY KEY,
        space_id      INTEGER NOT NULL,
        title         TEXT NOT NULL,
        discovered_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS kaiten_card_links (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id     INTEGER NOT NULL,
        field       TEXT NOT NULL,
        value       TEXT NOT NULL,
        created_at  INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS kaiten_card_moves (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id     INTEGER NOT NULL,
        title       TEXT,
        url         TEXT,
        to_column   TEXT NOT NULL,
        from_column TEXT,
        lane        TEXT,
        board       TEXT,
        note        TEXT,
        moved_at    INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS kaiten_columns (
        id            INTEGER PRIMARY KEY,
        board_id      INTEGER NOT NULL,
        title         TEXT NOT NULL,
        discovered_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS kaiten_custom_properties (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        type          TEXT,
        discovered_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS kaiten_lanes (
        id            INTEGER PRIMARY KEY,
        board_id      INTEGER NOT NULL,
        title         TEXT NOT NULL,
        discovered_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS kaiten_roles (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        discovered_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS kaiten_spaces (
        id            INTEGER PRIMARY KEY,
        title         TEXT NOT NULL,
        archived      INTEGER NOT NULL DEFAULT 0,
        discovered_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS kaiten_time_hints (
        card_id        INTEGER PRIMARY KEY,
        timer_id       INTEGER,
        role_id        INTEGER,
        comment        TEXT,
        started_at     TEXT,
        last_logged_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS loki_hosts (
        host          TEXT PRIMARY KEY,
        discovered_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS loki_services_by_host (
        host          TEXT NOT NULL,
        service       TEXT NOT NULL,
        discovered_at INTEGER NOT NULL,
        PRIMARY KEY (host, service)
    )`,
  `CREATE TABLE IF NOT EXISTS portainer_containers (
        portainer_url   TEXT NOT NULL,
        endpoint_id     INTEGER NOT NULL,
        endpoint_name   TEXT,
        container_id    TEXT NOT NULL,
        container_name  TEXT NOT NULL,
        server_number   INTEGER,
        state           TEXT,
        image           TEXT,
        discovered_at   INTEGER NOT NULL,
        PRIMARY KEY (portainer_url, endpoint_id, container_id)
    )`,
  `CREATE TABLE IF NOT EXISTS sheet_aliases (
        name       TEXT PRIMARY KEY,
        ss_id      TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS sheet_tabs (
        ss_id      TEXT NOT NULL,
        tab_name   TEXT NOT NULL,
        payload    BLOB NOT NULL,
        size_bytes INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (ss_id, tab_name)
    )`,
  `CREATE TABLE IF NOT EXISTS sl_clients (
        client_id   INTEGER PRIMARY KEY,
        server      TEXT,
        is_active   INTEGER NOT NULL,
        is_locked   INTEGER NOT NULL,
        is_deleted  INTEGER NOT NULL,
        synced_at   INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS sl_spreadsheets (
        ss_id          TEXT PRIMARY KEY,
        client_id      INTEGER NOT NULL,
        title          TEXT NOT NULL,
        template_name  TEXT,
        is_active      INTEGER NOT NULL,
        server         TEXT,
        synced_at      INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS sl_wb_sids (
        sid         TEXT NOT NULL,
        client_id   INTEGER NOT NULL,
        server      TEXT,
        synced_at   INTEGER NOT NULL,
        PRIMARY KEY (sid, client_id)
    )`,
  `CREATE TABLE IF NOT EXISTS x10_email_clients (
        email             TEXT PRIMARY KEY,
        target_user_id    TEXT NOT NULL,
        target_name       TEXT,
        is_email_verified INTEGER NOT NULL,
        owned_client_ids  TEXT NOT NULL,
        workspaces_json   TEXT NOT NULL,
        reason            TEXT NOT NULL,
        fetched_at        INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS x10_sessions (
        kind        TEXT NOT NULL,
        subject     TEXT NOT NULL,
        token       TEXT NOT NULL,
        reason      TEXT,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        PRIMARY KEY (kind, subject)
    )`,
  `CREATE TABLE IF NOT EXISTS xlsx_aliases (
        name       TEXT PRIMARY KEY,
        path       TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON cache(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_kaiten_boards_space ON kaiten_boards(space_id)`,
  `CREATE INDEX IF NOT EXISTS idx_kaiten_card_links_card ON kaiten_card_links(card_id, field)`,
  `CREATE INDEX IF NOT EXISTS idx_kaiten_card_moves_card ON kaiten_card_moves(card_id)`,
  `CREATE INDEX IF NOT EXISTS idx_kaiten_card_moves_moved_at ON kaiten_card_moves(moved_at)`,
  `CREATE INDEX IF NOT EXISTS idx_kaiten_columns_board ON kaiten_columns(board_id)`,
  `CREATE INDEX IF NOT EXISTS idx_kaiten_lanes_board ON kaiten_lanes(board_id)`,
  `CREATE INDEX IF NOT EXISTS idx_kaiten_time_hints_logged ON kaiten_time_hints(last_logged_at)`,
  `CREATE INDEX IF NOT EXISTS idx_loki_services_host ON loki_services_by_host(host)`,
  `CREATE INDEX IF NOT EXISTS idx_portainer_container_name ON portainer_containers(container_name)`,
  `CREATE INDEX IF NOT EXISTS idx_portainer_endpoint ON portainer_containers(endpoint_id)`,
  `CREATE INDEX IF NOT EXISTS idx_portainer_server_number ON portainer_containers(server_number)`,
  `CREATE INDEX IF NOT EXISTS idx_sheet_tabs_fetched_at ON sheet_tabs(fetched_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sl_clients_server ON sl_clients(server)`,
  `CREATE INDEX IF NOT EXISTS idx_sl_ss_client ON sl_spreadsheets(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sl_ss_title ON sl_spreadsheets(title)`,
  `CREATE INDEX IF NOT EXISTS idx_sl_wb_sids_client ON sl_wb_sids(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sl_wb_sids_sid ON sl_wb_sids(sid)`,
];
