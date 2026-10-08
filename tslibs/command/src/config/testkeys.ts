/**
 * Фикстура реестра для тестов команды `mpu config`: восемь ключей, какими
 * их собирает приложение (`platform/config.md`, «CLI-контракт»). Пять
 * первых — голдены канала `fixtures/config/` (описания побайтно), три
 * последних — ключи mpu (`image.dir`, `task.history`, `task.max_busy`).
 *
 * Пакет своих ключей не объявляет: их объявляют домены, список собирает
 * приложение. Здесь — тестовые данные механики команды; совпадение
 * собранного реестра с голденом сверяет приложение.
 */

import {
  type ConfigKey,
  ConfigRegistry,
  fixed,
  NO_FALLBACK,
  underHome,
} from "./registry.ts";

const KEYS: readonly ConfigKey[] = [
  {
    key: "sheet.default",
    type: "str",
    fallback: NO_FALLBACK,
    description:
      "Spreadsheet по умолчанию (ID/URL/alias/client_id/title) для `mpu sheet`",
  },
  {
    key: "xlsx.default",
    type: "str",
    fallback: NO_FALLBACK,
    description: "Путь или alias .xlsx по умолчанию для `mpu xlsx`",
  },
  {
    key: "sheet.cache.tab_ttl",
    type: "int",
    fallback: fixed("7200"),
    description: "TTL whole-tab кэша листов, секунды",
  },
  {
    key: "sheet.cache.max_tab_bytes",
    type: "int",
    fallback: fixed("10485760"),
    description: "Порог, выше которого таб не кэшируется, байты (после gzip)",
  },
  {
    key: "sheet.cache.max_total_mb",
    type: "int",
    fallback: fixed("500"),
    description: "Общий потолок кэша листов, МБ",
  },
  {
    key: "image.dir",
    type: "str",
    fallback: underHome("mr/mp/mpu/image"),
    description:
      "Каталог файлов методов образа для `mpu image sync` и `mpu image export`",
  },
  {
    key: "task.history",
    type: "int",
    fallback: fixed("3"),
    description:
      "Глубина журнала `mpu task` в порциях: 0 — только текущая, -1 — не чистить",
  },
  {
    key: "task.max_busy",
    type: "int",
    fallback: fixed("4"),
    description:
      "Предел одновременно занятых ролей оркестратора `mpu-task` по всем проектам",
  },
];

/** Реестр фикстуры — в порядке спеки. */
export const TEST_REGISTRY = new ConfigRegistry(KEYS);
