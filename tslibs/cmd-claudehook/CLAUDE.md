# CLAUDE.md — `@mpu/cmd-claudehook`

Адаптеры хуков Claude Code (`mpu claude-hook notification|pre-tool-use|
permission-request|stop|elicitation`) и канал `mpu claude-channel`: событие
приходит JSON-объектом на stdin, вопрос владельцу уходит в чат с ботом
(`@mpu/cmd-botquestions`). Потребитель — `ts/` монорепозитория mpu: реестр
берёт команды, ядро строк (`line`) — ответы хуков и разбор вызова тула,
сервер ядра (`backend`) — столы вопросов, сеансы, окна tmux и транскрипты;
ставит пакет архивом из `release/`. Экземпляры столов и сеансов и их время
жизни — у потребителя, пакет отдаёт устройство. Хуки вызывают бинарь `mpu`;
тестов со стендом приложения у пакета нет — все тесты в пакете.

Спеки — в `ts/docs/specs/` mpu (сессии пакета не видны): порция
`platform/tslibs-commands.md` (D8), договор пакета `platform/tslibs-package.md`;
поведение — `claude-hook-notification.md`,
`claude-hook-notification-snapshot.md`, `claude-hook-pre-tool-use.md`,
`claude-hook-permission-request.md`, `claude-hook-stop.md`,
`claude-hook-elicitation.md`, `claude-channel.md`; голдены —
`fixtures/claude-hook-notification/`, `fixtures/telegram-relay/`. Ссылки на
спеки в комментариях кода — от `ts/docs/specs/`.

## Команды

```bash
bun install
VITEST_MAX_FORKS=2 bun run gate   # biome → tsc → тесты Bun, Node, Deno → check:release
bun run build                     # dist/index.js и .d.ts
bun run release                   # release/mpu-cmd-claudehook-<версия>.tgz
bun run check:release             # сборка и упаковка = архив в release/
```

Формат и линт (`biome.json`) — набор `ts/biome.jsonc` с теми же выключенными
правилами (договор [D.1]): код переносится из `ts/` без правок стиля; почему
выключено каждое правило — в `ts/biome.jsonc`. `lib` в `tsconfig.json` — как
у `ts/`.

Рантаймы гейт гонит по одному. Поменялись исходники или `package.json` —
`bun run release` и архив в тот же коммит, иначе `check:release` красный.
Любое изменение `dist/` — новая версия: `version` в `package.json` и новый
архив одним коммитом, прежний удаляется, когда на него не ссылается ни один
пакет `tslibs/*`; потребитель переходит своей правкой `package.json`.

Под Vitest+Bun `zod` идёт через преобразование Vite
(`vitest.config.ts`, `server.deps.inline`): родной импорт внешнего модуля
теряет реэкспорт `z`.

## Раскладка

- `index.ts` — поверхность: команды для реестра, ответы хуков, столы
  вопросов, сеансы, окна и транскрипты — ровно то, что берёт потребитель, и
  типы частей их конструкторов. Прочее — внутренности.
- `src/` — устройство и тесты `*.test.ts` рядом с кодом; `src/testclock.ts`
  — поддельные часы тестов пакета (в `dist` не попадает).
- `src/testdata/` — копии канала `ts/docs/specs/fixtures/` байт-в-байт:
  `claude-hook-notification/` ← `claude-hook-notification/`,
  `permission-request/` ← `telegram-relay/hook/` и
  `telegram-relay/settings-fragment.json`, `stop/` ← `telegram-relay/r2/`,
  `elicitation/` ← `telegram-relay/r3/`, `snapshot/` ← `telegram-relay/r4/`.
  `permission-request-help.txt` — снятая справка `permission-request`.
  Сверить копии с каналом не может ни пакет, ни `ts/`, поэтому правило:
  копия меняется только переносом файла из канала тем же коммитом, что и
  эталон; Biome их не форматирует (`!**/testdata`).
- `release/` — архивы версий, коммитятся; `dist/` — нет.

## Порядок изменения

Гейт зелёный → разбор итогового диффа субагентом со свежим контекстом (не
автор) по чек-листам `../../ts/docs/checklists/review.md` + `review-mpu.md`
(сессию библиотеки запускают с `--add-dir` на этот каталог; копий нет) →
исправление найденного → гейт зелёный повторно → коммит. Ядро чек-листов:
объект держит свою память (запись + свободные функции над ней — не объект);
особый случай — отдельная реализация, а не ветка по виду; позднее связывание
и один null-объект на модуль вместо проверок `typeof`/`instanceof`/`null`;
голые данные (строка-код, булев флаг, кортеж) — протоколом.

## Правила кода

Действуют правила `ts/CLAUDE.md` mpu; главное из них:

- Ничего специфичного для рантайма: ни `Deno.*`, ни `Bun.*` — только `node:*`
  и npm. Тесты — Vitest, зелёные под Bun, Node и Deno.
- Пакет не знает о приложении: ни импорта из `ts/` (`registry`, `line`,
  `backend`), ни текстов, которые назначает приложение. Команда объявлена
  контрактом `@mpu/command`; регистрирует её реестр `ts/`.
- Функция ≤ 40 строк, вложенность ≤ 3; ранние выходы. JSDoc на каждом
  экспорте; комментарий объясняет «почему».
- Строгий TypeScript, без `any`; `as` и `!` — с обоснованием рядом.
- Бросаются только `Error` и подклассы; обёртка — через `cause`.
- Никакой работы при импорте. Синхронизация сном в тестах запрещена.

## Зависимости

Версии точные, без `^`; `bun.lock` коммитится. Библиотеки `tslibs/*` —
необязательные `peerDependencies` плюс `devDependencies` архивом
(договор [S.9]): потребитель ставит их сам, копия на граф одна.

- `zod` 4.4.3 — схемы аргументов и результата команд. **Обязательный**
  peer: схема пересекает границу пакета (её читает реестр потребителя), тип
  и рантайм — одного `zod`.
- `@mpu/command` (архивом) — контракт команды, порт io.
- `@mpu/cmd-botquestions` (архивом) — вопросы владельцу в чате с ботом:
  формы, исходы, часы; поддельный бот тестов —
  `@mpu/cmd-botquestions/testing`.
- `@mpu/language` (архивом) — контракт кадров (`/frames`): виды кадров
  хуков и канала, доставка кадра и ответ канала — одна форма у сервера и
  клиента `mpu`.
- `@mpu/base` (архивом) — ошибки ОС по коду (`/oserror`).
- `@mpu/subprocess` (архивом) — запуск `tmux` (окна и снимок экрана).
- `@mpu/testing` (dev, архивом) — пойманная ошибка (`/thrown`).
- Прочие `@mpu/*` в `devDependencies` — необязательные peer'ы пакетов выше,
  нужные тестам для загрузки; поверхность пакета их не называет.
- `vitest` 3.2.4 — тесты под тремя рантаймами; `@biomejs/biome` — формат и
  линт; `typescript`, `@types/node` — проверка типов и `.d.ts` сборки.
