# Порция N1 — общие мелочи и клиент GitLab пакетами `tslibs/base`, `tslibs/gitlab`

Статус: к реализации (2026-10-08), параллельно EX1. План —
`docs/plans/2026-10-08-tslibs-full-slicing.md`. Договор пакета —
`platform/tslibs-package.md`; поведение — `platform/gitlab-api.md` и спеки
команд-потребителей (не меняется).

## Граница (наблюдаемая, снято с `main` 2026-10-08)

- `tslibs/base` ← `back/src/{access,dates,oserror,workdir}` (листья графа, без
  зависимостей от `ts/`; 2, 9, 21 и 2 каталога-потребителя). Точки входа
  пакета — по одной на каталог (`@mpu/base/dates`, `@mpu/base/oserror`, …) или
  один `index.ts` — решает design-N1 по связности потребителей.
- `tslibs/gitlab` ← `back/src/gitlab` целиком (зависит от `oserror`,
  `subprocess`, `@mpu/http`): `api`, `diff`, `discussion`, `git`, `http`,
  `model`, `position`, `resolve`, `write`, фейки `testing.ts`
  (`@mpu/gitlab/testing`). `@mpu/subprocess` приходит из EX1: если EX1 ещё не
  слита к моменту кода — `git.ts` пока берёт `subprocess` из `ts/` нельзя
  (пакет не зависит от `ts/`); тогда `gitlab` ждёт EX1, а порция делает
  `base` и сообщает в отчёте.

## Сценарии [S.n]

1. В каждом пакете `bun install && bun run gate` → зелёно под Bun, Node,
   Deno, `check:release` зелёный; архивы `release/mpu-base-0.1.0.tgz`,
   `release/mpu-gitlab-0.1.0.tgz` закоммичены; зависимости на пакеты —
   необязательные `peerDependencies` плюс `devDependencies` архивом.
2. Списки листовых случаев перенесённых каталогов до = объединение после
   (пакеты + `ts/`), строка в строку.
3. `rg -n 'Deno\.|Bun\.' tslibs/base/src tslibs/gitlab/src` → пусто; в
   пакетах нет импорта из `ts/`; каталогов `ts/back/src/{access,dates,oserror,
   workdir,gitlab}` нет.
4. `ts/package.json` — оба архива; `cd ts && rm -rf node_modules/@mpu && bun
   install --frozen-lockfile` проходит; гейты `ts/` и `bun run smoke`
   зелёные.
5. Голдены команд `mr …`, `glab-status` и всех потребителей `dates`/`oserror`
   — без изменений и зелёные.
6. Токен GitLab не появляется ни в выводе, ни в тексте ошибки — существующие
   тесты зелёные.
7. Живьём (хост после установки): `mpu mr view …` на любом открытом MR,
   `mpu glab-status`, `mpu sun` — вывод той же формы, что до порции.

## Инварианты

- Наблюдаемое поведение не меняется.
- Пакеты не знают о слое команд: ни импорта из `ts/`.

## Пункты чек-листа

`design.md`: 1 примитивы — без изменений, перенос; 7 основание проверкой —
[S.2], [S.4]. `design-mpu.md`: 7 границы модулей — точки входа пакета;
прочее — ничего.
