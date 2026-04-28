---
name: sheet-cache
description: Внутреннее устройство `lib/sheet-cache.ts` — covering-cache над `WebappClient` для запросов `spreadsheets/values/batchGet`. Хранит ячейки поячеечно, склеивает частичные попадания, обходит FORMATTED_VALUE/whole-sheet/non-A1. Вызывать только при правках самого `sheet-cache.ts` или когда нужно понять/расширить логику кэширования Sheets API.
---

# Sheet covering-cache (`lib/sheet-cache.ts`)

`SheetCache` оборачивает `WebappClient`, реализуя интерфейс `SheetClient`. Хранит ячейки `sheet_cells(ss_id, sheet, row, col, v_json, f_text, fetched_at)` — отдельные колонки для UNFORMATTED_VALUE и FORMULA. На запрос `spreadsheets/values/batchGet`:

- каждый диапазон A1 парсится в прямоугольник;
- если все ячейки прямоугольника есть в кэше и `min(fetched_at)` свежее `ttl` → отдаём из кэша;
- частичные/expired попадания и `whole-sheet`/`FORMATTED_VALUE` идут в один объединённый network-запрос; ответ сохраняется поячеечно;
- результирующий `valueRanges` собирается в исходном порядке.

TTL: `sheet.cache.ttl` (0 = bypass). FORMATTED_VALUE никогда не кэшируется (locale-зависимо). Не-A1 / unparseable ranges — bypass. Действия кроме `batchGet` делегируются в inner без хранения.
