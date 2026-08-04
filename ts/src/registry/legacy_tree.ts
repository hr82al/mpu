/**
 * Записи маршрута `legacy`, порождённые из машинного слепка дерева
 * (`docs/specs/fixtures/platform/registry/tree.json`, mpuVersion
 * 0.1.0). Правка руками недопустима: пересобирается
 * `deno task registry:sync`, состав и однострокѝ сверяются со слепком
 * тестом `tree_test.ts`.
 *
 * Хранится литералом, а не чтением слепка в рантайме: слепок весит
 * 460 КБ, а быстрый старт — заявленная ценность `mpu`. Полное дерево
 * нужно публикации тулов, не маршрутизации (спека).
 */

import type { LegacyCommand } from "../legacy/mod.ts";

/** 54 команд верхнего уровня, ещё не переехавших на TS. */
export const LEGACY_TREE: readonly LegacyCommand[] = [
  {
    path: ["search"],
    summary:
      "Найти клиента (локальный кэш) ИЛИ получить доступ к web-клиенту 10X (impersonation).",
  },
  {
    path: ["update"],
    summary: "Синхронизировать ~/.config/mpu/mpu.db со всеми PG-серверами.",
  },
  {
    path: ["sql"],
    summary: "Выполнить SQL (write-capable) на PG, выбранном по селектору.",
  },
  {
    path: ["sql-ro"],
    summary:
      "Выполнить SQL в enforced read-only сессии (безопасный дефолт для чтения).",
  },
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
    summary:
      "sheet: get | ls | resolve | set | batch-update | batch-get | open … (+3)",
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
    path: ["run-js"],
    summary:
      "Выполнить ESM-код внутри контейнера sl-back через `node --input-type=module -`.",
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
    path: ["log"],
    summary:
      "`mpu log` — журнал вызовов самого `mpu` (не логи стенда, для них есть `mpu logs`).",
  },
  {
    path: ["logs"],
    summary:
      "Логи со стенда (Loki по умолчанию, --via portainer для legacy snapshot).",
  },
  {
    path: ["kiten"],
    summary:
      "kiten: status | ls | card | comment | desc | move | ready | review … (+10)",
  },
  {
    path: ["mr"],
    summary:
      "mr: view | create | describe | files | diff | comment | note … (+7)",
  },
  {
    path: ["glab-status"],
    summary: "Таблица прохождения MR по веткам деплой-пайплайна.",
  },
  { path: ["telegram"], summary: "telegram: send | status | ls | search" },
  {
    path: ["confirm"],
    summary: "Пропустить stdin → stdout по подтверждению; иначе прервать pipe.",
  },
  {
    path: ["wb-recalculate-expenses"],
    summary:
      "Выполнить через Portainer; `--print` — печать обёртки без выполнения.",
  },
  {
    path: ["wb-save-expenses"],
    summary:
      "Выполнить через Portainer; `--print` — печать обёртки без выполнения.",
  },
  {
    path: ["process"],
    summary:
      "Выполнить через Portainer; `--print` — печать обёртки без выполнения.",
  },
  {
    path: ["ss-update"],
    summary:
      "Выполнить через Portainer; `--print` — печать обёртки без выполнения.",
  },
  {
    path: ["ss-load"],
    summary:
      "Выполнить через Portainer; `--print` — печать обёртки без выполнения.",
  },
  {
    path: ["ss-datasets"],
    summary:
      "Выполнить через Portainer; `--print` — печать обёртки без выполнения.",
  },
  {
    path: ["wb-loader"],
    summary:
      "wb-loader: reports | cards | adv-auto-keywords-stats | adv-fullstats … (+4)",
  },
  {
    path: ["wb-jobs"],
    summary:
      "Выполнить service:wbJobs showJobs через Portainer (дефолт — сразу в проде); `--print`/`-p` — только печать команды.",
  },
  {
    path: ["wb-unit-calc"],
    summary:
      "Выполнить через Portainer; `--print` — печать обёртки без выполнения.",
  },
  {
    path: ["wb-unit-proto-new"],
    summary:
      "Миграция старой wb_unit_proto-таблицы в новую: `copy-data-from-old-table` — обёртка node cli через Portainer; `--print`/`-p` — только печать команды.",
  },
  {
    path: ["iu-wb"],
    summary: "iu-wb: get-source-data | make-sql | fix-formulas",
  },
  {
    path: ["ozon-loader"],
    summary:
      "ozon-loader: postings-reports | performance-reports | search-promo … (+4)",
  },
  { path: ["ozon-jobs"], summary: "ozon-jobs: show | prune" },
  {
    path: ["ozon-recalculate-expenses"],
    summary:
      "Выполнить через Portainer; `--print` — печать обёртки без выполнения.",
  },
  {
    path: ["ozon-save-expenses"],
    summary:
      "Выполнить через Portainer; `--print` — печать обёртки без выполнения.",
  },
  {
    path: ["ozon-fix-fo-tax"],
    summary:
      "Починить источник 1₽ и прогнать штатную цепочку пересчёта ОПиУ / Фин отчет SKU.",
  },
  {
    path: ["clients-migrations"],
    summary:
      "clients-migrations: latest | up | rollback | down | init | latest-all",
  },
  {
    path: ["make-schema"],
    summary:
      "clientsMigrations init: создать схему клиента в локальном mp-sl-N-cli.",
  },
  {
    path: ["datasets-migrations"],
    summary: "datasets-migrations: latest | up | rollback | down | list",
  },
  { path: ["app-migrations"], summary: "app-migrations: latest | up" },
  { path: ["users"], summary: "users: add | add-role" },
  {
    path: ["data-loader"],
    summary: "Обёртки над `node cli service:dataLoader` (sl-back).",
  },
  {
    path: ["data-loader-jobs"],
    summary:
      "Выполнить service:dataLoaderJobs showJobs через Portainer (дефолт — сразу в проде); `--print`/`-p` — только печать команды.",
  },
  {
    path: ["ssh"],
    summary:
      "Выполнить команду в `sl-N-cli` ИЛИ в произвольном контейнере по точному имени.",
  },
  { path: ["ps"], summary: "Список контейнеров." },
  {
    path: ["health"],
    summary:
      "Health-check: статусы контейнеров + tail логов потенциальных виновников.",
  },
  {
    path: ["init"],
    summary:
      "Discover все контейнеры через Portainer API и закэшировать в `~/.config/mpu/mpu.db`.",
  },
  {
    path: ["api"],
    summary:
      "api: add-client-ozon-key | add-client-wb-token | auth-change-password … (+95)",
  },
];
