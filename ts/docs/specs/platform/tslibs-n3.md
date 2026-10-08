# Порция N3 — слой команд пакетом `tslibs/command`

Статус: к реализации (2026-10-08), после N2. План —
`docs/plans/2026-10-08-tslibs-full-slicing.md`. Договор пакета —
`platform/tslibs-package.md`; поведение — `platform/command-contract.md` и
спеки, на которые ссылаются заголовки модулей (не меняется).

## Граница (наблюдаемая, снято с `main` 2026-10-08)

`tslibs/command` ← `back/src/{command,env,confirm,jsdate,selector,store,
config,policy,testing}` (~5k строк). Потребителей в `ts/`: `command` — ~405
файлов, `testing` — 121, `store` — 59, `policy` — 39, `selector` — 30,
`config` — 12. Зависимости — `@mpu/language` (`objects`, `picture`),
`@mpu/base` (`oserror`), `zod`; тестовые — `@mpu/testing`.

Точки входа — по каталогу (`@mpu/command`, `/env`, `/confirm`, `/jsdate`,
`/selector`, `/store`, `/config`, `/policy`); помощники тестов `ts/`
(`back/src/testing`: стенд кэша, область, запуск) — `@mpu/command/testing`.

Известная связь наружу: тест `config/cmd_config.test.ts` берёт `DEFAULTS` из
`../sheet/settings.ts` — пакет не может зависеть от `sheet` (порция D6). Этот
тест остаётся в `ts/` (`back/src/config/cmd_config.test.ts` поверх
`@mpu/command/config`) до переезда `sheet`; в design-N3 — так или иначе, с
причиной.

## Сценарии [S.n]

1. `tslibs/command`: `bun install && bun run gate` → зелёно под Bun, Node,
   Deno, `check:release` зелёный; архив `release/mpu-command-0.1.0.tgz`
   закоммичен; `@mpu/language`, `@mpu/base` — необязательные
   `peerDependencies` плюс `devDependencies` архивом.
2. Списки листовых случаев девяти каталогов до = после (пакет + `ts/`),
   строка в строку.
3. `rg -n 'Deno\.|Bun\.' tslibs/command/src` → пусто; в пакете нет импорта из
   `ts/`; каталогов `ts/back/src/{command,env,confirm,jsdate,selector,store,
   policy,testing}` нет (`config` — только тест из оговорки выше).
4. `ts/package.json` — архив; свежая установка с пустым кэшем Bun (договор
   [S.12]) проходит; гейты `ts/` и `bun run smoke` зелёные.
5. Все голдены `ts/` — без изменений и зелёные.
6. Живьём (хост после установки): `mpu help`, `mpu policy`, `mpu config`,
   `mpu kiten ls`, отказ на неизвестный ключ — вывод прежний.

## Инварианты

- Поведение команд не меняется.
- Пакет не знает о доменах команд (`kiten`, `sheet`, …).

## Пункты чек-листа

`design.md`: 1 примитивы — без изменений, перенос; 7 основание проверкой —
[S.2], [S.4]. `design-mpu.md`: 7 границы модулей — точки входа; прочее —
ничего.
