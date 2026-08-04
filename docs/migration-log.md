# MIGRATION.md — журнал переезда

## Умрёт вместе с Python (§1.2, решение 2026-07-27)

- **ozon-fix-fo-tax** — data-fix одного инцидента (источник 1 ₽ в
  ОПиУ/Фин отчёте SKU); сценарий исчерпан.
- **backup-wb-unit-proto**, **backup-ozon-unit-proto**,
  **backup-wb-unit-manual-data** — CTAS-бэкапы под конкретные
  ремедиации; при нужде бэкап делается штатным SQL (`CREATE TABLE … AS
  SELECT`), отдельные команды не оправданы.
- **wb-unit-proto-new** — разовая миграция старой
  `wb_unit_proto`-таблицы; выполнена.
- **sun** — восход/закат/зенит; вне домена mpu.
- **process, ss-load, ss-datasets, wb-unit-calc, wb-jobs, iu-wb,
  ozon-loader, ozon-jobs, data-loader-jobs, users, clients-migrations,
  datasets-migrations, app-migrations** — Portainer-обёртки над
  `node cli service:*` без вызовов за доступное окно журнала; при
  реальной нужде тот же вызов доступен как `node cli …` через `ssh`,
  отдельная команда на каждую не оправдана.
- **confirm** — вспомогательный pipe-фильтр подтверждения; без вызовов,
  шаблон использования не прижился.

## Принятые расхождения differential-сверки

(пока пусто — сверок не было)

## Идеи улучшений (из отчётов Go-сессий, отдельными задачами после)

(пока пусто)
