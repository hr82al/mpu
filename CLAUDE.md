# CLAUDE.md

Этот файл — инструкции для Claude Code при работе в данном репозитории.

## Контекст проекта

`mpu` — multi-purpose CLI утилита. **Разрабатывается с нуля на Node.js.** Поведение, набор команд, форматы данных, конфиги и архитектура будут определены в процессе работы — **не копировать автоматически** из других проектов.

## Референсные кодовые базы (только для изучения, не для копирования)

Две соседние кодовые базы служат **источником понимания**, как устроены соответствующие задачи. Они не являются спецификацией — ни одна деталь (имя команды, флаг, схема БД, формат конфига, имя env-переменной, структура директорий) не переносится без явного указания пользователя.

| Где | Что из этого можно почерпнуть |
|-----|------------------------------|
| `mpu-old/` (в этом же репо) | Прежняя Go-реализация mpu. Показывает, как раньше были устроены команды, HTTP-общение с Google Apps Script, кэш, auth, работа с PG, REPL, smart-defaults. Используется как **источник понимания предметной области** — какие задачи вообще решаются. |
| `/home/user/mr/mp/` | Монорепо marketplace-платформы (sl-back, sw-back, sw-front, mp-config-local) с которой mpu взаимодействует. Показывает, **как устроены внешние системы** (API, PG-схемы, NATS, multi-tenancy) и какие Node-конвенции приняты в соседних проектах. |

### Правила использования референсов

1. **Читать — можно**, чтобы понять, как что-то работает или работало.
2. **Копировать код, имена, конфиги, схемы — только по явной просьбе пользователя.** Если видно "как было сделано раньше", это информация, а не готовое решение.
3. **Не ссылаться на mpu-old как на спецификацию.** Если пользователь просит команду `X` — не надо искать `mpu-old/cmd/x.go` и воспроизводить её флаги/поведение 1:1. Спросить, какое поведение нужно.
4. **`mpu-old/CLAUDE.md`** описывает старую систему. Не применять его правила (Janet-first, бенчмарки, cgo-специфику) к новому проекту.
5. **`/home/user/mr/mp/CLAUDE.md`** описывает соседний монорепо. Его конвенции (Docker-wrap тестов, путь к конфигам, специфичные SQL-хелперы) относятся к тому монорепо, а не к mpu.
6. Если в референсе встречается явно полезный факт о **внешней системе, с которой mpu должен работать** (например, формат запроса к Apps Script, схема таблицы в PG, эндпоинт sl-back) — его можно использовать, потому что это описание внешнего мира, а не внутреннего решения mpu.

## Стек (согласован)

- **TypeScript + ESM**, Node >= 22. Вход — `src/bin/mpu.ts`, сборка в `dist/`.
- **commander** — CLI-фреймворк. Один bin `mpu` с subcommand; каждая subcommand — один файл в `src/commands/`, легко выносится в отдельный bin через `package.json#bin` при необходимости.
- **better-sqlite3** — синхронный SQLite (единый файл `$XDG_CONFIG_HOME/mpu/mpu.db` или `$MPU_DB`) для конфига и кэша.
- **Jest (ts-jest, ESM preset)** + `@jest/globals` (обязательный явный импорт в `.test.ts`). NODE_OPTIONS зашиты в `package.json` скрипты — запуск через `npm test [-- <jest args>]`.
- **ESLint flat config + Prettier** — конфиги в корне. `npm run lint`, `npm run typecheck`, `npm run format`.

## Структура (фиксированная)

```
src/
  bin/mpu.ts                    # shebang + buildProgram().parseAsync()
  program.ts                    # buildProgram() — собирает root + subs
  commands/
    <name>.ts                   # одна команда — один файл; экспортирует фабрику
    internal-complete.ts        # hidden runtime handler для автодополнения
  lib/
    paths.ts                    # defaultDbPath() — XDG-aware
    db.ts                       # openDb(), getDefaultDb(), миграции
    config.ts                   # Config + CONFIG_REGISTRY (registry с типом/default/описанием)
    cache.ts                    # Cache: get/set/delete/clear/wrap/wrapAsync
    completion.ts               # walker, провайдеры, emit bash/fish/zsh, installPath
    help.ts                     # describe(cmd, { summary, description?, examples? })
tests/                          # *.test.ts, выделены в отдельные файлы по модулям
```

## Ключевые конвенции кода

### Help у команд — только через `describe()`

Никаких многострочных `.description([...].join('\n'))` с рукописным блоком `Examples:`. Единая точка форматирования:

```ts
import { describe } from '../lib/help.js';

describe(cmd, {
  summary: 'Short one-liner for parent listing',
  description: 'Full paragraph for the command\'s own --help',  // optional — fallback to summary
  examples: [
    { cmd: 'mpu foo', note: 'what it does' },
    { cmd: 'mpu foo --bar 1' },                                 // note optional
  ],
});
```

`describe()` делает `.summary()` + `.description()` + `addHelpText('after', ...)`. Пример-блок сам выравнивается. Расширять help — расширять `HelpSpec`, команды не трогать.

### Completion — `setProvider()` на команде

Каждая команда с позиционными аргументами или выбором значения должна декларировать provider:

```ts
import { setProvider } from '../lib/completion.js';

setProvider(cmd, ({ args, cursor }) => {
  if (args.length === 0) return candidatesForFirstPositional();
  if (args.length === 1) return candidatesForSecondPositional(args[0]);
  return [];
});
```

Фильтрация по префиксу — автоматически в runtime `complete()`. Subcommand-кандидаты, `--options`, `--help`/`-h` — тоже автоматически. Provider отвечает только за уникальные для команды значения.

### Config и Cache используются из любого места через default-инстансы

```ts
import { getDefaultCache } from './lib/cache.js';

const cache = getDefaultCache();
const data = await cache.wrapAsync('k', fetchData, { ttl: 600 });    // cache-aside
cache.wrap('cheap', compute);                                         // sync variant
cache.set('k', v, { ttl: Infinity });                                 // never expires
cache.set('k', v, { ttl: 0 });                                        // no-op (don't cache this call)
// без ttl → берётся config.get('cache.ttl')
```

**Один knob — `cache.ttl`.** `0` = кэш отключён глобально (master-switch, перекрывает per-call `opts.ttl`). `>0` = кэш включён с таким дефолтным TTL в секундах. Отдельного `cache.enabled` нет.

Новые ключи конфига — добавлять в `CONFIG_REGISTRY` в `src/lib/config.ts`. Они сразу получают тип-проверку, валидацию, автодополнение в `mpu config <TAB>`, и видимы в `mpu config` (list).

### Тесты — `@jest/globals` + `:memory:` SQLite

```ts
import { describe, it, expect, beforeEach } from '@jest/globals';
import { openDb } from '../src/lib/db.js';

beforeEach(() => {
  db = openDb(':memory:');  // изолированная БД на каждый тест
});
```

Не полагаться на `os.homedir()` в тестах — в Jest VM-контексте `HOME` нестабилен. Использовать `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `MPU_DB` для подмены путей.

Описания `describe`/`it` — по-русски, префикс `Проверяет: ...` (конвенция из соседнего mp-монорепо).

### Скрипты

```
npm run build         # tsc → dist/
npm run dev           # tsc --watch
npm run start         # node dist/bin/mpu.js
npm test              # все тесты
npm test -- <path>    # один файл
npm test -- -t "name" # по имени
npm run test:watch
npm run test:coverage
npm run lint          # eslint
npm run lint:fix
npm run format
npm run typecheck     # tsc --noEmit
```

## Что всё ещё НЕ определено

- Доменные команды mpu (webApp, client, ldb, rdb и т.д.) — ни одна ещё не реализована, **спрашивать перед созданием**.
- Env-переменные для внешних систем (Apps Script URL, sl-back API, PG) — пока не забраны из старого `.env`.
- REPL — нужен ли, и на чём (Node `repl`, WASM Janet, свой lisp, JS-eval) — открытый вопрос, не начинать без согласования.

## Общие принципы разработки

Эти правила применяются с самого начала, независимо от выбранного стека:

1. **Никаких лишних слоёв.** Не добавлять обёртки/абстракции "на будущее". Багфикс не тянет за собой рефакторинг. Три похожие строки лучше преждевременной абстракции.
2. **Никаких "на всякий случай"**: не писать error-handling, fallbacks, валидации для невозможных сценариев. Доверять внутреннему коду и гарантиям фреймворков. Валидировать только на границах системы (пользовательский ввод, внешние API).
3. **Комментарии — только когда WHY не очевидно.** Не комментировать, что делает код (хорошие имена уже это показывают). Не писать "used by X" / "added for Y" — это устаревает.
4. **TDD** — любой новый функционал или багфикс начинается с падающего теста, воспроизводящего причину. Красный → минимум кода до зелёного → рефакторинг.
5. **DRY / Naming.** Перед написанием новой функции — искать существующую в этом же репо. Имя переменной отражает что хранится, а не намерение.
6. **Язык.** Тексты (README, комментарии к тестам, PR-описания) — по-русски, если пользователь не укажет иначе. Идентификаторы — по-английски.

## Сейчас в репо

- `mpu-old/` — прежняя Go-реализация (референс).
- `.env` / `.env.enc` — окружение от прежней реализации. Не использовать без согласования.
- Собранная инфраструктура: commander-CLI, SQLite config+cache, автодополнения (bash/fish/zsh), help-хелпер. Готова к добавлению доменных команд.

## Как начинать работу над задачей

1. Понять задачу от пользователя. Если она ссылается на старое поведение ("как в старом mpu") — прочитать соответствующий кусок `mpu-old/`, чтобы восстановить контекст, и **подтвердить с пользователем**, нужно ли такое же поведение в новой версии или другое.
2. Перед новой зависимостью, новым файлом в корне, новой схемой БД, новой таблицей, именами команд/флагов — **спросить пользователя до создания**.
3. Внутри согласованной структуры — действовать самостоятельно:
   - новая команда → `src/commands/<name>.ts` с фабрикой, `describe()` для help, `setProvider()` если нужно автодополнение значений, регистрация в `src/program.ts`
   - новый ключ конфига → добавить в `CONFIG_REGISTRY`
   - кэширование внешнего вызова → `cache.wrapAsync(key, fn, { ttl })`
   - тесты рядом с модулем в `tests/<module>.test.ts`
