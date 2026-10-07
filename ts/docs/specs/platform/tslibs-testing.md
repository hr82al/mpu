# Пакет `tslibs/testing` — общие тестовые помощники

Порция H2 (после H1, до T1). Решение владельца 2026-10-07: тестовый
HTTP-сервер и `rejected` после H1 живут в двух копиях
(`ts/back/src/testing/{http,thrown}.ts` и `tslibs/http/src/testing/`), T1
сделала бы третью. Договор пакета — `tslibs-package.md`.

## Кто и зачем

Тесты `ts/` и тесты пакетов `tslibs/*` берут общие помощники из одного места —
`@mpu/testing`, поставленного архивом как `devDependency`. В бою пакет не
участвует.

## Поверхность

Ровно то, что сегодня экспортируют обе копии (объединение; поведение — как у
`ts/back/src/testing/`, у которого больше возможностей):

- `serveFetch(handler, tls?)` — сервер на петле, `tls` — TLS (тип `Tls`);
  `FetchHandler`, `FakeHttp` (сигнатура копии `ts/` сохранена);
- `listenLoopback(server)`, `closedPort()`;
- `rejected(promise, ErrorClass)` — точка входа `@mpu/testing/thrown`.

Прочие помощники `ts/back/src/testing/` в пакет не идут: они знают о домене
`ts/` (стенд `back`, журнал, клиент строк).

## Сценарии [S.n]

1. `cd tslibs/testing && bun install && bun run gate` → зелёно (договор пакета
   [S.1]–[S.4], [S.10]).
2. `rg -n "serveFetch|listenLoopback|closedPort|export async function rejected" ts/back/src tslibs/http/src`
   → определений помощников нет, только импорты из `@mpu/testing`
   (`serveFetch` рабочего сервера в `backend/loopback.ts` — не помощник, остаётся).
3. `ts/back/src/testing/http.ts`, `ts/back/src/testing/thrown.ts`,
   `tslibs/http/src/testing/` удалены; `tslibs/http/package.json` без
   точки входа `./testing`, если ничего, кроме этих помощников, в ней не было.
4. `ts/package.json` и `tslibs/http/package.json`:
   `"@mpu/testing": "file:../…/tslibs/testing/release/mpu-testing-0.1.0.tgz"`
   в `devDependencies`.
5. Список листовых случаев до/после: `ts/` + `tslibs/http` + `tslibs/testing`
   — то же множество имён, кроме перенесённых тестов самих помощников (они
   теперь в `tslibs/testing`, по одному разу).
6. Гейты `ts/` (`bun run gate`) и обоих пакетов зелёные; `check:release`
   ([S.10] договора) добавлен и в `tslibs/http`.

## Границы

- Поведение помощников не меняется; объединение двух копий — по копии `ts/`,
  расхождение в поведении — вопрос в отчёте, а не выбор молча.
- Остальные помощники `ts/back/src/testing/` остаются на месте.
