/**
 * Записи маршрута `legacy`, порождённые из машинного слепка дерева
 * (`docs/specs/fixtures/platform/registry/tree.json`, mpuVersion
 * 0.1.0). Правка руками недопустима: пересобирается
 * `deno task registry:sync`, состав и однострокѝ сверяются со слепком
 * тестом `tree_test.ts`.
 *
 * Хранится литералом, а не чтением слепка в рантайме: слепок весит
 * сотни килобайт, а быстрый старт — заявленная ценность `mpu`. Полное
 * дерево нужно публикации тулов, не маршрутизации (спека).
 */

import type { LegacyCommand } from "../legacy/mod.ts";

/** 23 команд верхнего уровня, ещё не переехавших на TS. */
export const LEGACY_TREE: readonly LegacyCommand[] = [
  {
    path: ["sun"],
    summary:
      "Считает локально (astral, без сети) восход/закат/зенит и длину дня.",
  },
  {
    path: ["config"],
    summary:
      "Показать или изменить конфиг mpu (хранится в SQLite; env-переменные приоритетнее).",
  },
  {
    path: ["sheet"],
    summary: "Google Spreadsheets через Apps Script webapp (native Python).",
  },
  {
    path: ["backup-wb-unit-proto"],
    summary:
      "CTAS-бэкап: CREATE TABLE backups.<table>_<schema_id>_<YYYYMMDD> AS SELECT * FROM schema_<schema_id>.<table>.",
  },
  {
    path: ["backup-ozon-unit-proto"],
    summary:
      "CTAS-бэкап: CREATE TABLE backups.<table>_<schema_id>_<YYYYMMDD> AS SELECT * FROM schema_<schema_id>.<table>.",
  },
  {
    path: ["backup-wb-unit-manual-data"],
    summary:
      "CTAS-бэкап: CREATE TABLE backups.<table>_<schema_id>_<YYYYMMDD> AS SELECT * FROM schema_<schema_id>.<table>.",
  },
  {
    path: ["d2-miro"],
    summary: "Рендер d2-диаграммы в Miro как редактируемый фрейм.",
  },
  {
    path: ["copy-client"],
    summary:
      "Скопировать клиента с прод-PG в локальный dev-PG (`sl-1`), нативно (`pg_dump`/COPY).",
  },
  {
    path: ["copy-dev"],
    summary:
      "Скопировать данные с dev в локальный docker-стек (`pg_dump`/`pg_restore`).",
  },
  {
    path: ["copy-shared"],
    summary:
      "Скопировать shared-таблицы с source-сервера, выбранного через селектор.",
  },
  {
    path: ["clean-local-clients"],
    summary:
      "Снести локальные данные клиентов кроме keep-листа (`--yes` — выполнить, иначе dry-run).",
  },
  {
    path: ["mp-init"],
    summary:
      "Создать сеть (если нет), поднять core SL backend + web-стек (up -d --force-recreate).",
  },
  {
    path: ["move-client"],
    summary:
      "Перенести клиента с source-sl на target-sl через mp-dt-cli (BullMQ createJob).",
  },
  {
    path: ["move-client-back"],
    summary:
      "Реверс переноса по записи `move-client`; `ls` — список, `rm <selector>` — удалить запись.",
  },
  {
    path: ["mr"],
    summary:
      "GitLab MR review: инлайн-комментарии под строкой диффа, треды, create/describe.",
  },
  {
    path: ["glab-status"],
    summary: "Таблица прохождения MR по веткам деплой-пайплайна.",
  },
  {
    path: ["telegram"],
    summary:
      "Telegram от имени пользователя (telethon): send — отправить, ls — диалоги, search — поиск.",
  },
  {
    path: ["confirm"],
    summary: "Пропустить stdin → stdout по подтверждению; иначе прервать pipe.",
  },
  {
    path: ["process"],
    summary:
      "Выполнить через Portainer; `--print` — печать обёртки без выполнения.",
  },
  {
    path: ["iu-wb"],
    summary: "Обёртки над `node cli service:iuWb` (sl-back).",
  },
  {
    path: ["ozon-fix-fo-tax"],
    summary:
      "Починить источник 1₽ и прогнать штатную цепочку пересчёта ОПиУ / Фин отчет SKU.",
  },
  {
    path: ["make-schema"],
    summary:
      "clientsMigrations init: создать схему клиента в локальном mp-sl-N-cli.",
  },
  {
    path: ["api"],
    summary: "HTTP API клиенты для sl-back (бывшие `mpuapi-*`).",
  },
];
