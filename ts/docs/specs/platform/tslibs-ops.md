# Порция OP1 — клиенты Portainer и Loki пакетами `tslibs/portainer`, `tslibs/loki`

Статус: к реализации после KA1 (2026-10-07). Гибрид владельца 2026-10-07:
TS-домены — пакеты `tslibs/<домен>` в монолите. Договор пакета —
`platform/tslibs-package.md`; поведение — `platform/portainer.md`,
`platform/loki-http.md` (не меняется). Оба клиента маленькие (~300 строк
каждый), уже на `@mpu/http`, со слоем команд почти не связаны; одна порция,
два пакета.

## Кто и зачем

Разработчик хочет, чтобы разговор с Portainer API (environment'ы,
контейнеры, снимок логов, разбор потока Docker) и с Loki (`query_range`,
серии хостов и сервисов) был библиотекой без привязки к рантайму и к слою
команд; команды `init`, `logs`, `ps`, `health`, `update` берут их архивом.

## Граница (наблюдаемая, снято с `main` 2026-10-07)

- `tslibs/portainer` ← `back/src/portainer/` целиком (`mod.ts`, тесты
  `demux`, `portainer`, `portainer_tls`). Связей со слоем команд нет.
- `tslibs/loki` ← `back/src/loki/` (`mod.ts`, тесты, `testdata/`), кроме
  `writeLokiCache` (пишет в `CacheDb` слоя команд) — она остаётся в `ts/`,
  как прогрев Kaiten в KA1.
- `back/src/exec/portainer.ts` (исполнение в контейнере по WebSocket,
  `RemoteOutput`, `DomainError`, `shell`/`tar`/`ws`) — не в этой порции: это
  домен `exec`, со слоем команд связан плотно.

## Сценарии [S.n]

1. `tslibs/portainer` и `tslibs/loki`: в каждом `bun install && bun run gate`
   → зелёно под Bun, Node, Deno, `check:release` зелёный; архивы
   `release/mpu-portainer-0.1.0.tgz`, `release/mpu-loki-0.1.0.tgz`
   закоммичены; `@mpu/http` — необязательный `peerDependency` плюс
   `devDependency` архивом; тестовые помощники — `@mpu/testing`.
2. Списки листовых случаев `back/src/portainer` и `back/src/loki` до =
   объединение после (пакеты + `ts/`), строка в строку.
3. `rg -n 'Deno\.|Bun\.' tslibs/portainer/src tslibs/loki/src` → пусто; в
   пакетах нет импорта из `ts/`; каталогов `ts/back/src/portainer`,
   `ts/back/src/loki` нет, кроме места `writeLokiCache` (где — по
   design-OP1).
4. `ts/package.json` — оба архива; `cd ts && rm -rf node_modules/@mpu && bun
   install --frozen-lockfile` проходит; гейты `ts/` и `bun run smoke`
   зелёные.
5. Голдены команд `init`, `logs`, `ps`, `health`, `update` — без изменений и
   зелёные.
6. Обе таблицы кэша Loki перезаписываются целиком или не трогаются
   (инвариант `loki-http.md`) — существующие тесты зелёные.
7. Живьём (хост после установки): `mpu ps`, `mpu logs …` (одна служба,
   короткий хвост), `mpu health` — вывод той же формы, что до порции.

## Инварианты

- Наблюдаемое поведение команд не меняется.
- Пакеты не знают о слое команд: ни импорта из `ts/`, ни кэш-БД.

## Решения после OP1

- Копия фикстуры `series-ok.json` и сверка `fixtures.test.ts` остаются в
  `ts/back/src/loki/` (иначе [S.2] теряет два случая); копию в пакете
  сторожит правило `CLAUDE.md` пакета, как в KA1. Направить сверку `ts/` на
  папку пакета — значит читать чужую папку из `ts/` (нарушение автономии);
  единый источник фикстур для пакетов — отдельный вопрос, не сейчас.
- Тест атомарности `writeLokiCache` (сбой вставки посреди записи → обе
  таблицы прежние) — пунктом порции SB1.

## Границы

- `exec` (`exec/portainer.ts`, `ws.ts`, `tar.ts`, `shell.ts`) — отдельной
  порцией, если дойдёт по связности.
- Самоописание `about`, конверт — этап 6.

## Пункты чек-листа

`design.md`: 1 примитивы — запрос к Portainer, запрос `query_range`; прочее
выведено; 7 основание проверкой — [S.2], [S.4]. `design-mpu.md`: 4 один
источник — протоколы Portainer/Docker и Loki в пакетах; 7 границы модулей —
`index.ts`; 8 внешнее — адреса и ключи параметрами; прочее — ничего.
