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

/** 56 команд верхнего уровня, ещё не переехавших на TS. */
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
      "sheet: get | ls | resolve | set | batch-update | batch-get | open | sync | alias | cache",
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
      "kiten: status | ls | card | comment | desc | move | ready | review | close | whoami | spaces | roles | boards | lanes | columns | time | field | checklist",
  },
  {
    path: ["mr"],
    summary:
      "mr: view | create | describe | files | diff | comment | note | comments | show | reply | edit | delete | resolve | unresolve",
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
    path: ["help"],
    summary: "Список всех mpu команд с опциональной справкой.",
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
      "wb-loader: reports | cards | adv-auto-keywords-stats | adv-fullstats | search-texts | analytics-by-period | adverts | search-clusters-bids",
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
      "ozon-loader: postings-reports | performance-reports | search-promo | campaign-daily-statistics | campaigns | transactions | load-data",
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
  { path: ["version"], summary: "Show mpu version." },
  {
    path: ["init"],
    summary:
      "Discover все контейнеры через Portainer API и закэшировать в `~/.config/mpu/mpu.db`.",
  },
  {
    path: ["api"],
    summary:
      "api: add-client-ozon-key | add-client-wb-token | auth-change-password | auth-login | auth-logout | auth-refresh | auth-resend-email | auth-verify | cli-log-heartbeat | cli-log-subscribe | cli-log-unsubscribe | cli-manifest | cli-run | cli-servers | create-client | create-client-spreadsheet | create-client-ss-dataset | create-spreadsheet | create-user | dataset-get | dataset-save | dataset-wb-unit-source | delete-client | delete-client-ozon-key | delete-client-spreadsheet | delete-client-ss-dataset | delete-client-wb-token | delete-spreadsheet | delete-user | destroy-client | dl-jobs-abort | dl-jobs-active-jobs | dl-jobs-by-state | dl-jobs-job | dl-jobs-queue-status | dl-jobs-remove | get-client | get-client-module | get-client-spreadsheet | get-client-ss-dataset | get-spreadsheet | get-ss-values | get-token | get-user | get-wb-cabinet-module | get-wb-cabinets-by-sid | integrity-findings | integrity-runs | integrity-skips | integrity-trigger | list-client-modules | list-client-ozon-keys | list-client-spreadsheets | list-client-ss-datasets | list-client-wb-cabinets | list-client-wb-tokens | list-clients | list-roles | list-spreadsheets | list-users | list-wb-cabinet-modules | list-wb-cabinets | ozon-jobs-abort | ozon-jobs-active-jobs | ozon-jobs-by-state | ozon-jobs-job | ozon-jobs-queue-status | ozon-jobs-remove | ss-access | ss-datasets-update | ss-jobs-abort | ss-jobs-active-jobs | ss-jobs-by-state | ss-jobs-job | ss-jobs-queue-status | ss-jobs-submit | update-client | update-client-module | update-client-spreadsheet | update-client-ss-dataset | update-spreadsheet | update-user | update-wb-cabinet-module | wb-cards-reset | wb-jobs-abort | wb-jobs-active-jobs | wb-jobs-by-state | wb-jobs-job | wb-jobs-queue-status | wb-jobs-remove | wb-loader-blocked | wb-loader-config | wb-loader-load | wb-loader-reset | wb-loader-resume | wb-loader-status | wb-token-ping-content | wb-token-seller-info",
  },
];
