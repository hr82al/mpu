# Порция N4 — журнал вызовов пакетом `tslibs/invokelog`

Статус: к реализации (2026-10-08), после N3. План —
`docs/plans/2026-10-08-tslibs-full-slicing.md`. Договор пакета —
`platform/tslibs-package.md`; поведение — `invoke-log.md` (не меняется).

## Граница (снято с `main` 2026-10-08)

`tslibs/invokelog` ← `back/src/invokelog` (~1k строк): `mod`, `file`, `mask`,
`record`, `settings`. Зависимости — `@mpu/command`, `@mpu/base` (`oserror`),
`proper-lockfile`, `zod`. Потребители в `ts/`: `entrypoint`, `process`,
`log`, `mcp`, `backend`, `line`, `task` (тесты). Тесты журнала, которым нужен
стенд приложения (`entrypoint`, `mcp`, `registry`), остаются в `ts/` поверх
пакета.

## Сценарии [S.n]

1. `tslibs/invokelog`: `bun install && bun run gate` → зелёно под Bun, Node,
   Deno, `check:release` зелёный; архив закоммичен.
2. Списки листовых случаев `invokelog` до = после (пакет + `ts/`), строка в
   строку.
3. `rg -n 'Deno\.|Bun\.' tslibs/invokelog/src` → пусто; в пакете нет импорта
   из `ts/`; каталога `ts/back/src/invokelog` нет (кроме тестов из оговорки).
4. Свежая установка с пустым кэшем Bun проходит; гейты `ts/` и `bun run
   smoke` зелёные.
5. Ротация под локом, маскирование секретов, права 0600 — существующие тесты
   зелёные.
6. Живьём (хост после установки): `mpu log` — последние записи прежней
   формы, новая запись появляется после вызова.

## Инварианты

- Поведение журнала не меняется; секреты маскируются как прежде.
