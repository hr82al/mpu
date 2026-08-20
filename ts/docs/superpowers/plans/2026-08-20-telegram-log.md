# mpu telegram log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить команду `mpu telegram log MESSAGE`, отправляющую текст в личного Telegram-бота через Bot API, с маскированием аргумента в журнале вызовов.

**Architecture:** Второй транспорт внутри группы `telegram`, не пересекающийся с MTProto-частью: своя конфигурация (`bot_config.ts`), свой клиент поверх платформенного HTTP-шва `src/http/mod.ts` (`bot.ts`), своя команда (`cmd_log.ts`). Сеанс MTProto, резолв адресата и план отправки не используются. Отдельно — платформенная правка: команда может пометить себя как «аргументы в журнал не пишутся».

**Tech Stack:** Deno 2.9.4, TypeScript, `@zod/zod` для схемы аргументов, `defineCommand` (`src/command/mod.ts`), `httpSend` (`src/http/mod.ts`), `@std/assert` для тестов.

**Spec:** `ts/docs/superpowers/specs/2026-08-20-telegram-log-design.md`

## Global Constraints

- Рабочий каталог всех команд — `ts/`. Тесты: `deno task test`, форматирование: `deno fmt`, проверка типов: `deno check main.ts`.
- **Коммитить только с pathspec.** Каталоги `docs/` и `py/` в корне репозитория закрыты песочницей и выглядят для git удалёнными; массовая операция закоммитит их удаление. Форма коммита в этом репозитории: добавлять конкретные пути `ts/…` и завершать команду коммита ограничителем `-- ts/`.
- Сеть наружу в тестах запрещена. Право теста — `--allow-net=127.0.0.1`: тест транспорта поднимает `Deno.serve` на петле и передаёт его адрес базовым URL.
- Права собранного бинаря менять не нужно: `--allow-net` в задаче `build` уже без ограничения хоста.
- Env-ключи ровно эти, переименованию не подлежат: `TELEGRAM_BOT_TOKEN` (обязателен), `TELEGRAM_BOT_ID` (обязателен, числовой, `chat_id` получателя), `TELEGRAM_BOT_NAME` (необязателен, только в тексте ошибки).
- Опции выбора адресата у команды нет и не появляется. Апдейты (`getUpdates`, webhook) не читаются. Это требование безопасности из спеки, раздел «Модель угрозы», п. 1.
- Комментарии в коде — по-русски, в стиле окружающих файлов: объясняют «почему», а не «что».
- Каждая задача заканчивается коммитом. Сообщения — в стиле репозитория: `feat(telegram): …`, `test(telegram): …`, `docs(telegram): …`.
- **Команды `Run:` внутри шагов — только внутренний цикл TDD.** Перед каждым коммитом обязателен полный набор гейтов из `ts/CLAUDE.md`: `deno fmt --check && deno lint && deno check . && deno task test --coverage=cov`, затем `deno coverage cov` по затронутым модулям и `deno task smoke`, затем разбор итогового диффа свежим контекстом (`git diff -- ts/`). Гейты зелёные → разбор → исправления → гейты зелёные повторно → коммит.
- **Мутационная проверка обязательна для тестов маскирования (Task 4):** они закрепляют инвариант «текст не попадает в журнал». Сломать маскирование в коде, увидеть красноту теста, вернуть код; в отчёте перечислить прогнанные мутации. Для тестов разбора и рендера она желательна, но не обязательна.

---

### Task 1: Спека команды в канале спецификаций

**Эту задачу выполняет сессия-спецификатор (та, что написала план), а не исполнитель.** Реализующей Deno-сессии `docs/` запрещён к правке (`ts/CLAUDE.md`: «Не трогать `.claude/` и `docs/`»), поэтому делегировать Task 1 нельзя — иначе исполнитель либо откажется, либо нарушит своё же правило. Делегируются задачи начиная со второй.

Спека пишется первой и отдельным коммитом: дальше она источник истины.

**Files:**
- Create: `ts/docs/specs/telegram-log.md`
- Modify: `ts/docs/specs/platform/invoke-log.md` (раздел «Инварианты»)

**Interfaces:**
- Consumes: ничего.
- Produces: наблюдаемый контракт, на который ссылаются все последующие задачи.

- [ ] **Step 1: Написать спеку команды**

Создать `ts/docs/specs/telegram-log.md`:

```markdown
# mpu telegram log

Статус: к реализации

## Назначение

Отправить себе заметку или уведомление в личного Telegram-бота. В отличие от
`send`, отправка идёт от имени бота (Bot API), а не от личного аккаунта: чат с
ботом не виден командам `telegram ls` и `telegram search`, а текст сообщения не
попадает в журнал вызовов.

## CLI-контракт

mpu telegram log MESSAGE

- `MESSAGE` — позиционный, обязателен. Значение `-` означает «весь stdin».
- Опций нет. Адресат единственный, из `TELEGRAM_BOT_ID`; опции его выбора нет
  намеренно: динамический адресат означал бы, что сообщение может уйти
  постороннему, написавшему боту.

## Ввод/вывод

stdin читается целиком тогда и только тогда, когда `MESSAGE` равен `-`.

stdout — одна строка JSON, за ней один перевод строки; пробел после двоеточия
входит в форму:

{"id": 5000001}

Источник значения: `id` — `result.message_id` ответа Bot API. `chat_id` в вывод
не идёт намеренно: секция `out` пишется в журнал, и адресат оказался бы в ней.

## Побочные эффекты

Один POST на `https://api.telegram.org`. Апдейты не читаются, состояние не
пишется, файлы не создаются.

## Конфигурация

- `TELEGRAM_BOT_TOKEN` — обязателен. Токен бота от BotFather.
- `TELEGRAM_BOT_ID` — обязателен. `chat_id` получателя.
- `TELEGRAM_BOT_NAME` — необязателен. Username бота; попадает только в
  подсказку при отказе доставки. Пустое значение равнозначно незаданному.

Ключи сеанса MTProto (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
`TELEGRAM_SESSION`) команде не нужны: неавторизованный `mpu init` её не
блокирует.

## Инварианты

- Адресат сообщения равен `TELEGRAM_BOT_ID` при любом вводе: другого источника
  адресата у команды нет.
- Апдейты Bot API не запрашиваются ни при каком исходе.
- Запись журнала вызовов не содержит текста сообщения ни в каком виде
  (`platform/invoke-log.md`).
- Значение `TELEGRAM_BOT_TOKEN` не появляется ни в stdout, ни в stderr, ни в
  журнале.

## Граничные случаи и ошибки

- `MESSAGE` — пустая строка, либо `-` при пустом (или состоящем из пробельных
  символов) stdin → `telegram: нужен непустой MESSAGE`, exit 2.
- `TELEGRAM_BOT_TOKEN` или `TELEGRAM_BOT_ID` отсутствует либо пуст → сообщение
  слоя env-файла с именем ключа и путём файла, exit 1.
- `TELEGRAM_BOT_ID` — не число → `telegram: TELEGRAM_BOT_ID должен быть числом,
  получено '<строка>'`, exit 1. Ведущий минус допустим: так выглядят id групп и
  каналов.
- Ответ с `ok: false` → `telegram: bot API <error_code> <description>`, exit 1.
- Описание отказа содержит `chat not found` либо `bot was blocked` → тот же
  текст плюс `; напиши боту @<name> /start`; часть `@<name>` присутствует
  только при заданном `TELEGRAM_BOT_NAME`.
- Тело ответа не разбирается как JSON → `telegram: bot API вернул не JSON:
  <первая строка тела>`, exit 1.
- Ответ с `ok: true` без `result.message_id` → `telegram: bot API не сообщил
  номер сообщения`, exit 1.
- Сбой вызова (сеть, предел времени) → `telegram: bot API недоступен: <причина
  одной строкой>`, exit 1.

## Golden-примеры

- `fixtures/telegram-log/log-stdout.txt` — успешная отправка.
- `fixtures/telegram-log/err-empty-text-stderr.txt` — пустой MESSAGE.

## Известные отклонения

нет (команда новая, оригинала в Python-реализации у неё нет).

## Открытые вопросы

нет.
```

- [ ] **Step 2: Дополнить спеку журнала**

В `ts/docs/specs/platform/invoke-log.md`, раздел «Инварианты», после абзаца про маскирование секретов добавить пункт:

```markdown
- Отдельные команды помечены как «аргументы не журналируются»: у такой команды
  все аргументы после пути команды заменяются той же маской `REDACTED`
  независимо от имён, а JSON-аргументы MCP-вызова заменяются маской целиком.
  Пометка — свойство команды в реестре, не эвристика по argv: маскирование по
  имени опции остаётся правилом по умолчанию для всех прочих. Такова
  `telegram log` (`specs/telegram-log.md`), чей единственный аргумент —
  персональный текст. Секции out/err пометка не затрагивает.
```

- [ ] **Step 3: Проверить, что упоминания не разъехались**

Run: `cd ts && grep -rn "telegram log" docs/specs/`
Expected: совпадения только в `telegram-log.md` и `platform/invoke-log.md`.

- [ ] **Step 4: Commit**

Добавить в индекс `ts/docs/specs/telegram-log.md` и `ts/docs/specs/platform/invoke-log.md`, закоммитить с сообщением:

```
docs(telegram): спека telegram log и пометка маскирования аргументов
```

Ограничитель `-- ts/` в команде коммита обязателен (см. Global Constraints).

---

### Task 2: Конфигурация бота

**Files:**
- Create: `ts/src/telegram/bot_config.ts`
- Create: `ts/src/telegram/bot_config_test.ts`

**Interfaces:**
- Consumes: `EnvKeys` из `./config.ts` (уже экспортирован: `Pick<EnvFile, "get" | "require">`), `configError` из `./errors.ts`, `DomainError` из `../command/mod.ts`.
- Produces:
  - `export interface BotConfig { readonly token: string; readonly chatId: number; readonly botName?: string }`
  - `export function botConfig(env: EnvKeys): BotConfig`

- [ ] **Step 1: Написать падающий тест**

Создать `ts/src/telegram/bot_config_test.ts`:

```ts
/**
 * Конфигурация бота (`docs/specs/telegram-log.md`, «Конфигурация»):
 * свои ключи, не пересекающиеся с сеансом MTProto.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import { botConfig } from "./bot_config.ts";
import type { EnvKeys } from "./config.ts";

/** Env поверх словаря: пустое значение равнозначно незаданному ключу. */
function fakeEnv(values: Readonly<Record<string, string>>): EnvKeys {
  return {
    get: (name) => values[name],
    require: (name) => {
      const value = values[name];
      if (value === undefined || value === "") {
        throw new DomainError(
          `environment variable ${name} is not set. Add it to /tmp/.env or export in shell.`,
        );
      }
      return value;
    },
  };
}

Deno.test("оба обязательных ключа заданы — конфигурация собрана", () => {
  const config = botConfig(fakeEnv({
    TELEGRAM_BOT_TOKEN: "8123456789:AAH-token",
    TELEGRAM_BOT_ID: "987654321",
    TELEGRAM_BOT_NAME: "my_notes_bot",
  }));
  assertEquals(config.token, "8123456789:AAH-token");
  assertEquals(config.chatId, 987654321);
  assertEquals(config.botName, "my_notes_bot");
});

Deno.test("имя бота необязательно — поля нет", () => {
  const config = botConfig(
    fakeEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_BOT_ID: "1" }),
  );
  assertEquals(config.botName, undefined);
});

Deno.test("пустое имя бота равнозначно незаданному", () => {
  const config = botConfig(fakeEnv({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_BOT_ID: "1",
    TELEGRAM_BOT_NAME: "",
  }));
  assertEquals(config.botName, undefined);
});

Deno.test("нет токена — ошибка конфигурации с именем ключа", () => {
  const err = assertThrows(
    () => botConfig(fakeEnv({ TELEGRAM_BOT_ID: "1" })),
    DomainError,
  );
  assertEquals(err.message.includes("TELEGRAM_BOT_TOKEN"), true);
});

Deno.test("нет id — ошибка конфигурации с именем ключа", () => {
  const err = assertThrows(
    () => botConfig(fakeEnv({ TELEGRAM_BOT_TOKEN: "t" })),
    DomainError,
  );
  assertEquals(err.message.includes("TELEGRAM_BOT_ID"), true);
});

Deno.test("нечисловой id — свой текст отказа", () => {
  const err = assertThrows(
    () =>
      botConfig(fakeEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_BOT_ID: "меня" })),
    DomainError,
  );
  assertEquals(
    err.message,
    "telegram: TELEGRAM_BOT_ID должен быть числом, получено 'меня'",
  );
});

Deno.test("отрицательный id принимается — так выглядят группы", () => {
  const config = botConfig(fakeEnv({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_BOT_ID: "-1001234567890",
  }));
  assertEquals(config.chatId, -1001234567890);
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd ts && deno test --allow-read --allow-write --allow-env src/telegram/bot_config_test.ts`
Expected: FAIL — модуль `./bot_config.ts` не найден.

- [ ] **Step 3: Минимальная реализация**

Создать `ts/src/telegram/bot_config.ts`:

```ts
/**
 * Конфигурация отправки в личного бота (`docs/specs/telegram-log.md`,
 * «Конфигурация»).
 *
 * Отдельно от `telegramConfig()`: у сеанса MTProto свои обязательные
 * ключи, и смешение сделало бы отправку в бота заложником входа
 * `mpu init` — она от сессии не зависит вовсе.
 */

import { DomainError } from "../command/mod.ts";
import type { EnvKeys } from "./config.ts";
import { configError } from "./errors.ts";

/** Разобранная конфигурация бота. */
export interface BotConfig {
  readonly token: string;
  /** Единственный адресат; выбор чата команде недоступен по построению. */
  readonly chatId: number;
  /** Username бота; нужен только подсказке в тексте отказа доставки. */
  readonly botName?: string;
}

/** Читает конфигурацию; непригодное значение — ошибка конфигурации. */
export function botConfig(env: EnvKeys): BotConfig {
  const token = required(env, "TELEGRAM_BOT_TOKEN");
  const chatId = required(env, "TELEGRAM_BOT_ID");
  // Минус в начале — обычный вид id группы или канала, поэтому знак
  // разрешён; всё прочее означает, что в ключе лежит не идентификатор.
  if (!/^-?\d+$/.test(chatId)) {
    throw configError(
      `TELEGRAM_BOT_ID должен быть числом, получено '${chatId}'`,
    );
  }
  const botName = env.get("TELEGRAM_BOT_NAME");
  return {
    token,
    chatId: Number(chatId),
    // Пустое значение равнозначно незаданному — поле не заводится.
    ...(botName === undefined || botName === "" ? {} : { botName }),
  };
}

/** Обязательный ключ: сообщение слоя env-файла несёт имя ключа и путь. */
function required(env: EnvKeys, name: string): string {
  try {
    return env.require(name);
  } catch (err) {
    if (err instanceof DomainError) {
      throw configError(err.message, { cause: err });
    }
    throw err;
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `cd ts && deno test --allow-read --allow-write --allow-env src/telegram/bot_config_test.ts`
Expected: PASS, 7 тестов.

- [ ] **Step 5: Формат и типы**

Run: `cd ts && deno fmt src/telegram/bot_config.ts src/telegram/bot_config_test.ts && deno check src/telegram/bot_config.ts`
Expected: без ошибок.

- [ ] **Step 6: Commit**

Добавить `ts/src/telegram/bot_config.ts` и `ts/src/telegram/bot_config_test.ts`, сообщение:

```
feat(telegram): конфигурация личного бота из ключей TELEGRAM_BOT_*
```

---

### Task 3: Транспорт Bot API

**Files:**
- Create: `ts/src/telegram/bot.ts`
- Create: `ts/src/telegram/bot_test.ts`

**Interfaces:**
- Consumes: `BotConfig` из `./bot_config.ts` (Task 2); `httpSend`, `HttpCallError`, `firstLine` из `../http/mod.ts`; `configError` из `./errors.ts`.
- Produces:
  - `export const TELEGRAM_API_BASE = "https://api.telegram.org"`
  - `export interface BotSent { readonly id: number }`
  - `export function sendBotMessage(config: BotConfig, text: string, apiBase?: string): Promise<BotSent>`

`apiBase` — параметр с умолчанием, а не константа внутри: тест обязан ходить на петлю, наружу сети у него нет.

- [ ] **Step 1: Написать падающий тест**

Создать `ts/src/telegram/bot_test.ts`:

```ts
/**
 * Транспорт Bot API (`docs/specs/telegram-log.md`): запрос, разбор
 * ответа и раскладка отказов. Сервер поднимается на петле — наружу
 * тесты не ходят (`ts/CLAUDE.md`).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import type { BotConfig } from "./bot_config.ts";
import { sendBotMessage } from "./bot.ts";

const CONFIG: BotConfig = { token: "8123:AAH", chatId: 987654321 };

/** Сервер на петле: отдаёт заготовленный ответ и записывает запрос. */
async function withServer(
  handler: (request: Request) => Response | Promise<Response>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  try {
    await run(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test("успешная отправка — номер сообщения из ответа", async () => {
  await withServer(
    () =>
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 5000001 } }),
      ),
    async (base) => {
      const sent = await sendBotMessage(CONFIG, "привет", base);
      assertEquals(sent.id, 5000001);
    },
  );
});

Deno.test("запрос несёт токен в пути и адресата в теле", async () => {
  let seenPath = "";
  let seenBody: unknown = null;
  await withServer(
    async (request) => {
      seenPath = new URL(request.url).pathname;
      seenBody = await request.json();
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
      );
    },
    async (base) => {
      await sendBotMessage(CONFIG, "текст", base);
    },
  );
  assertEquals(seenPath, "/bot8123:AAH/sendMessage");
  assertEquals(seenBody, { chat_id: 987654321, text: "текст" });
});

Deno.test("ok:false — код и описание в сообщении отказа", async () => {
  await withServer(
    () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: message is too long",
        }),
        { status: 400 },
      ),
    async (base) => {
      const err = await assertRejects(
        () => sendBotMessage(CONFIG, "x", base),
        DomainError,
      );
      assertEquals(err.message, "telegram: bot API 400 Bad Request: message is too long");
    },
  );
});

Deno.test("403 — подсказка написать боту, с именем из конфигурации", async () => {
  await withServer(
    () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 403,
          description: "Forbidden: bot was blocked by the user",
        }),
        { status: 403 },
      ),
    async (base) => {
      const err = await assertRejects(
        () => sendBotMessage({ ...CONFIG, botName: "my_notes_bot" }, "x", base),
        DomainError,
      );
      assertEquals(
        err.message,
        "telegram: bot API 403 Forbidden: bot was blocked by the user; напиши боту @my_notes_bot /start",
      );
    },
  );
});

Deno.test("chat not found — та же подсказка без имени, если оно не задано", async () => {
  await withServer(
    () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: chat not found",
        }),
        { status: 400 },
      ),
    async (base) => {
      const err = await assertRejects(
        () => sendBotMessage(CONFIG, "x", base),
        DomainError,
      );
      assertEquals(
        err.message,
        "telegram: bot API 400 Bad Request: chat not found; напиши боту /start",
      );
    },
  );
});

Deno.test("тело не разбирается как JSON — отказ, а не молчаливый успех", async () => {
  await withServer(
    () => new Response("<html>502</html>", { status: 502 }),
    async (base) => {
      const err = await assertRejects(
        () => sendBotMessage(CONFIG, "x", base),
        DomainError,
      );
      assertEquals(err.message.startsWith("telegram: bot API вернул не JSON"), true);
    },
  );
});

Deno.test("сервер недоступен — причина одной строкой", async () => {
  // Порт заведомо закрыт: сервер поднят и сразу остановлен.
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => new Response(""),
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  await server.shutdown();
  const err = await assertRejects(
    () => sendBotMessage(CONFIG, "x", base),
    DomainError,
  );
  assertEquals(err.message.startsWith("telegram: bot API недоступен: "), true);
  assertEquals(err.message.includes("\n"), false);
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd ts && deno test --allow-read --allow-write --allow-env --allow-net=127.0.0.1 src/telegram/bot_test.ts`
Expected: FAIL — модуль `./bot.ts` не найден.

- [ ] **Step 3: Проверить, что `firstLine` экспортирован**

Run: `cd ts && grep -n "export function firstLine" src/http/mod.ts`
Expected: строка найдена. Если экспорта нет — добавить `export` существующей функции и упомянуть это в сообщении коммита.

- [ ] **Step 4: Минимальная реализация**

Создать `ts/src/telegram/bot.ts`:

```ts
/**
 * Отправка в личного бота по Bot API (`docs/specs/telegram-log.md`).
 *
 * Bot API — JSON поверх HTTP, поэтому клиента протокола здесь нет:
 * транспорт общий с прочими внешними системами (`../http/mod.ts`) — от
 * него два предела времени и причина отказа одной строкой. MTProto
 * (`./session.ts`) не задействован: другой протокол и другая модель
 * доступа, и команда не должна платить за крипту MTProto.
 *
 * Апдейты не читаются намеренно: адресат берётся только из
 * конфигурации, иначе сообщение могло бы уйти постороннему,
 * написавшему боту (спека, «CLI-контракт»).
 */

import { firstLine, HttpCallError, httpSend } from "../http/mod.ts";
import type { BotConfig } from "./bot_config.ts";
import { configError } from "./errors.ts";

/** Адрес Bot API; параметром — чтобы тест ходил на петлю, а не наружу. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Ответ об отправке: наружу уходит только номер сообщения. */
export interface BotSent {
  readonly id: number;
}

/** Описания, при которых отказ означает «диалог с ботом не начат». */
const NEEDS_START = ["chat not found", "bot was blocked"];

/** Отправляет текст единственному адресату конфигурации. */
export async function sendBotMessage(
  config: BotConfig,
  text: string,
  apiBase: string = TELEGRAM_API_BASE,
): Promise<BotSent> {
  const url = new URL(`${apiBase}/bot${config.token}/sendMessage`);
  let response;
  try {
    response = await httpSend(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text }),
    });
  } catch (err) {
    if (err instanceof HttpCallError) {
      throw configError(
        `bot API недоступен: ${firstLine(err.message)}`,
        { cause: err },
      );
    }
    throw err;
  }
  return parseReply(response.text, config);
}

/** Разбор ответа: успех — номер сообщения, отказ — код и описание. */
function parseReply(text: string, config: BotConfig): BotSent {
  let reply: {
    ok?: boolean;
    error_code?: number;
    description?: string;
    result?: { message_id?: number };
  };
  try {
    reply = JSON.parse(text);
  } catch {
    // Не JSON — это не Bot API на том конце: шлюз, прокси или
    // заглушка. Молча считать успехом нельзя.
    throw configError(`bot API вернул не JSON: ${firstLine(text)}`);
  }
  if (reply.ok !== true) throw configError(failureText(reply, config));
  const id = reply.result?.message_id;
  if (typeof id !== "number") {
    throw configError("bot API не сообщил номер сообщения");
  }
  return { id };
}

/** Текст отказа; у «диалог не начат» — подсказка, что делать. */
function failureText(
  reply: { error_code?: number; description?: string },
  config: BotConfig,
): string {
  const code = reply.error_code ?? 0;
  const description = reply.description ?? "без описания";
  const base = `bot API ${code} ${description}`;
  if (!NEEDS_START.some((marker) => description.includes(marker))) return base;
  // Единственная реальная причина на старте — боту ещё не написали:
  // первым он писать не вправе.
  const name = config.botName === undefined ? "" : ` @${config.botName}`;
  return `${base}; напиши боту${name} /start`;
}
```

- [ ] **Step 5: Запустить тест и убедиться, что он проходит**

Run: `cd ts && deno test --allow-read --allow-write --allow-env --allow-net=127.0.0.1 src/telegram/bot_test.ts`
Expected: PASS, 7 тестов.

- [ ] **Step 6: Формат и типы**

Run: `cd ts && deno fmt src/telegram/bot.ts src/telegram/bot_test.ts && deno check src/telegram/bot.ts`
Expected: без ошибок.

- [ ] **Step 7: Commit**

Добавить `ts/src/telegram/bot.ts` и `ts/src/telegram/bot_test.ts`, сообщение:

```
feat(telegram): транспорт Bot API поверх общего HTTP-шва
```

---

### Task 4: Маскирование аргументов в журнале вызовов

**Files:**
- Modify: `ts/src/command/mod.ts` (~243 спец, ~296 тип, ~381 умолчание)
- Modify: `ts/src/invokelog/mod.ts` (~44 `OutputPolicy`, ~160 сборка записи, ~178 `lineOf`)
- Modify: `ts/src/invokelog/mask.ts`
- Modify: `ts/src/mcp/native_tool.ts:17`
- Modify: `ts/src/invokelog/mask_test.ts`

**Interfaces:**
- Consumes: ничего. Задача самостоятельна: умолчание `logsArguments` — `true`, поведение существующих команд не меняется, и первый потребитель пометки появляется в Task 5.
- Produces:
  - `CommandSpec.logsArguments?: boolean` (умолчание `true`), `Command.logsArguments: boolean`
  - `OutputPolicy` дополняется `readonly logsArguments: boolean` и `readonly path: readonly string[]`
  - `commandLine(argv: readonly string[], options?: { readonly maskFrom?: number }): string`
  - `toolCommandLine(path: readonly string[], input: unknown, options?: { readonly masked?: boolean }): string`

- [ ] **Step 1: Написать падающие тесты маскирования**

В конец `ts/src/invokelog/mask_test.ts` добавить:

```ts
Deno.test("помеченная команда: аргументы после пути заменены маской", () => {
  assertEquals(
    commandLine(["telegram", "log", "личная заметка"], { maskFrom: 2 }),
    "mpu telegram log REDACTED",
  );
});

Deno.test("помеченная команда: маскируется каждый аргумент, не только первый", () => {
  assertEquals(
    commandLine(["telegram", "log", "текст", "--чужое", "значение"], {
      maskFrom: 2,
    }),
    "mpu telegram log REDACTED REDACTED REDACTED",
  );
});

Deno.test("путь команды маской не трогается", () => {
  assertEquals(
    commandLine(["telegram", "log"], { maskFrom: 2 }),
    "mpu telegram log",
  );
});

Deno.test("без пометки правило прежнее: маскируются только опции-секреты", () => {
  assertEquals(
    commandLine(["telegram", "send", "привет"]),
    "mpu telegram send привет",
  );
});

Deno.test("помеченный тул: JSON аргументов заменён маской целиком", () => {
  assertEquals(
    toolCommandLine(["telegram", "log"], { message: "личное" }, {
      masked: true,
    }),
    "mpu telegram log REDACTED",
  );
});
```

- [ ] **Step 2: Запустить и убедиться, что тесты падают**

Run: `cd ts && deno test --allow-read --allow-write --allow-env src/invokelog/mask_test.ts`
Expected: FAIL — `commandLine` игнорирует второй аргумент, маска не появляется.

- [ ] **Step 3: Реализовать маскирование в `mask.ts`**

В `ts/src/invokelog/mask.ts` заменить `commandLine` и `toolCommandLine`:

```ts
/** Пометка команды: аргументы в запись не попадают ни в каком виде. */
export interface MaskOptions {
  /**
   * Индекс, с которого argv — аргументы, а не путь команды. Задан —
   * всё, начиная с него, заменяется маской независимо от имён: у
   * помеченной команды персонален сам аргумент, а не значение опции с
   * говорящим именем (`platform/invoke-log.md`, «Инварианты»).
   */
  readonly maskFrom?: number;
}

/** Строка команды CLI: литеральное `mpu`, затем argv после маскирования. */
export function commandLine(
  argv: readonly string[],
  options: MaskOptions = {},
): string {
  const masked = options.maskFrom === undefined ? maskArgv(argv) : [
    ...argv.slice(0, options.maskFrom),
    ...argv.slice(options.maskFrom).map(() => REDACTED),
  ];
  return ["mpu", ...masked.map(shellQuote)].join(" ");
}

/**
 * Строка команды вызова тула MCP-сервером: путь команды через пробел и
 * JSON аргументов одной строкой (спека, «Запись вызова через
 * MCP-сервер»). У помеченной команды JSON заменяется маской целиком:
 * персональна вся полезная нагрузка, а не отдельные её ключи.
 */
export function toolCommandLine(
  path: readonly string[],
  input: unknown,
  options: { readonly masked?: boolean } = {},
): string {
  if (options.masked === true) return ["mpu", ...path, REDACTED].join(" ");
  const json = JSON.stringify(maskJsonValue(input).value) ?? "null";
  return ["mpu", ...path, shellQuote(json)].join(" ");
}
```

- [ ] **Step 4: Запустить тесты маскирования**

Run: `cd ts && deno test --allow-read --allow-write --allow-env src/invokelog/mask_test.ts`
Expected: PASS, включая пять новых.

- [ ] **Step 5: Провести пометку от спеца команды до журнала**

В `ts/src/command/mod.ts` рядом с `logsOutput` добавить в спец команды:

```ts
  /**
   * Пишутся ли аргументы этой команды в запись журнала вызовов
   * (`platform/invoke-log.md`, «Инварианты»). Умолчание — да; `false`
   * у команды, чей аргумент персонален сам по себе, а не как значение
   * опции с говорящим именем: `telegram log`
   * (`docs/specs/telegram-log.md`). Запись о вызове остаётся, секции
   * out/err не затрагиваются — исчезают только аргументы.
   */
  readonly logsArguments?: boolean;
```

В тип `Command`:

```ts
  /** Пишутся ли аргументы в журнал вызовов (см. объявление). */
  readonly logsArguments: boolean;
```

В сборку команды, рядом с `logsOutput: spec.logsOutput ?? true`:

```ts
    logsArguments: spec.logsArguments ?? true,
```

В `ts/src/invokelog/mod.ts` расширить `OutputPolicy`:

```ts
/** Пометка команды: пишутся ли в её запись секции out/err и аргументы. */
export interface OutputPolicy {
  readonly logsOutput: boolean;
  /** Пишутся ли аргументы; `false` — они заменяются маской. */
  readonly logsArguments: boolean;
  /** Путь команды: по его длине маска отделяет аргументы от имени. */
  readonly path: readonly string[];
}
```

В `finish` заменить `commandLine: lineOf(command)` на `commandLine: lineOf(command, policy)` и переписать `lineOf`:

```ts
function lineOf(command: InvokeCommand, policy: OutputPolicy): string {
  const masked = !policy.logsArguments;
  switch (command.kind) {
    case "argv":
      // Путь команды стоит в argv первым, и его длину знает реестр:
      // разбирать argv заново журналу нечем и незачем.
      return commandLine(
        command.argv,
        masked ? { maskFrom: policy.path.length } : {},
      );
    case "tool":
      return toolCommandLine(command.path, command.input, { masked });
    default: {
      const unknown: never = command;
      throw new TypeError(`неизвестный вид вызова: ${JSON.stringify(unknown)}`);
    }
  }
}
```

В `ts/src/mcp/native_tool.ts:17` дополнить проброс:

```ts
    journal: {
      logsOutput: command.logsOutput,
      logsArguments: command.logsArguments,
      path: command.path,
    },
```

CLI-путь (`ts/src/entrypoint/mod.ts:340`) правки не требует: туда передаётся сам `Command`, у которого все три поля уже есть.

- [ ] **Step 6: Прогнать полный набор тестов**

Run: `cd ts && deno task test`
Expected: PASS. Ожидаемые падения и что с ними делать:
- `src/invokelog/wiring_test.ts`, `mod_test.ts`, `record_test.ts` — фейковые политики стали неполными: дописать `logsArguments: true` и `path: ["…"]`.
- Golden-фикстуры записи журнала — сверить и обновить обе копии одинаково.

- [ ] **Step 7: Проверить типы и формат**

Run: `cd ts && deno fmt && deno check main.ts`
Expected: без ошибок. Поведение команд не изменилось: пометку пока никто не выставляет.

- [ ] **Step 8: Commit**

Добавить `ts/src/command/mod.ts`, `ts/src/invokelog/`, `ts/src/mcp/native_tool.ts` и обновлённые фикстуры журнала, сообщение:

```
feat(invokelog): пометка команды, чьи аргументы не попадают в журнал
```

---

### Task 5: Команда `mpu telegram log`

**Files:**
- Create: `ts/src/telegram/cmd_log.ts`
- Create: `ts/src/telegram/cmd_log_test.ts`
- Modify: `ts/src/telegram/mod.ts`
- Modify: `ts/src/registry/mod.ts:75-79` (импорт) и `:180-183` (регистрация)
- Modify: `ts/src/registry/contract_test.ts` (после блока `path: "telegram send"`, ~строка 863)

**Interfaces:**
- Consumes: `botConfig` (Task 2), `sendBotMessage` (Task 3), `defineCommand` и `CommandIo` из `../command/mod.ts`, `inputError` из `./errors.ts` (даёт `VerbatimUsageError` с префиксом `telegram: ` и кодом 2).
- Produces:
  - `export function logText(args: { readonly message: string }, io: Pick<CommandIo, "readStdin">): Promise<string>` — вынесен ради тестов без сети.
  - `export const telegramLogCommand` — `path: ["telegram", "log"]`, `policy: "rw"`, результат `{ id: number }`.

- [ ] **Step 1: Сверить фабрики ошибок слоя**

Run: `cd ts && sed -n "1,45p" src/telegram/errors.ts`
Expected: `inputError` → `VerbatimUsageError` (код 2), `configError` → `VerbatimError` (код 1), оба с префиксом `telegram: `. Префикс несёт сам слой, имя подкоманды в текст ошибки не входит — эталон `testdata/telegram-send/err-empty-text-stderr.txt` содержит `telegram: пустой текст сообщения`.

- [ ] **Step 2: Написать падающий тест**

Создать `ts/src/telegram/cmd_log_test.ts`:

```ts
/**
 * Команда `mpu telegram log` (`docs/specs/telegram-log.md`): разбор
 * ввода. Сеть не задействована — проверяется всё, что решается до неё.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { VerbatimUsageError } from "../command/mod.ts";
import { logText } from "./cmd_log.ts";

/** Порт чтения stdin: команда читает его только при MESSAGE = '-'. */
function io(stdin: string): { readStdin: () => Promise<Uint8Array> } {
  return { readStdin: () => Promise.resolve(new TextEncoder().encode(stdin)) };
}

Deno.test("обычный текст берётся из аргумента, stdin не читается", async () => {
  let read = false;
  const text = await logText({ message: "заметка" }, {
    readStdin: () => {
      read = true;
      return Promise.resolve(new Uint8Array());
    },
  });
  assertEquals(text, "заметка");
  assertEquals(read, false);
});

Deno.test("дефис означает весь stdin", async () => {
  const text = await logText({ message: "-" }, io("две\nстроки\n"));
  assertEquals(text, "две\nстроки\n");
});

Deno.test("пустой аргумент — ошибка ввода", async () => {
  await assertRejects(
    () => logText({ message: "" }, io("")),
    VerbatimUsageError,
    "нужен непустой MESSAGE",
  );
});

Deno.test("пустой stdin — та же ошибка ввода", async () => {
  await assertRejects(
    () => logText({ message: "-" }, io("   \n")),
    VerbatimUsageError,
    "нужен непустой MESSAGE",
  );
});
```

- [ ] **Step 3: Запустить тест и убедиться, что он падает**

Run: `cd ts && deno test --allow-read --allow-write --allow-env src/telegram/cmd_log_test.ts`
Expected: FAIL — модуль `./cmd_log.ts` не найден.

- [ ] **Step 4: Реализовать команду**

Создать `ts/src/telegram/cmd_log.ts`:

```ts
/**
 * Команда `mpu telegram log` (`docs/specs/telegram-log.md`): заметка
 * или уведомление себе через личного бота.
 *
 * Здесь только склейка: конфигурация — `bot_config.ts`, отправка —
 * `bot.ts`. Сеанс MTProto не открывается: у канала другой протокол, и
 * в этом весь смысл команды — чат с ботом недостижим для `ls` и
 * `search`, а текст не попадает в журнал (пометка `logsArguments`).
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import { sendBotMessage } from "./bot.ts";
import { botConfig } from "./bot_config.ts";
import { inputError } from "./errors.ts";

const argsSchema = z.object({
  message: z.string({ error: "нужен MESSAGE: текст заметки либо '-'" })
    .describe("текст заметки; '-' — весь stdin"),
});

const resultSchema = z.object({
  id: z.number().describe("номер отправленного сообщения"),
});

type LogArgs = z.infer<typeof argsSchema>;
type LogResult = z.infer<typeof resultSchema>;

/** Срез порта: только чтение stdin и ключи env-файла. */
type LogIo = Pick<CommandIo, "readStdin" | "envFile">;

/**
 * Текст сообщения: аргумент либо весь stdin. Вынесено из `run`, чтобы
 * разбор ввода проверялся без сети.
 */
export async function logText(
  args: LogArgs,
  io: Pick<CommandIo, "readStdin">,
): Promise<string> {
  const text = args.message === "-"
    ? new TextDecoder().decode(await io.readStdin())
    : args.message;
  if (text.trim() === "") throw inputError("нужен непустой MESSAGE");
  return text;
}

/** Весь ввод и конфигурация — до сети; сеанс MTProto не открывается. */
async function runTelegramLog(args: LogArgs, io: LogIo): Promise<LogResult> {
  const text = await logText(args, io);
  const config = botConfig(io.envFile);
  const sent = await sendBotMessage(config, text);
  return { id: sent.id };
}

export const telegramLogCommand = defineCommand({
  path: ["telegram", "log"],
  errorName: "telegram log",
  summary: "Отправить заметку себе в личного бота.",
  usage: "mpu telegram log MESSAGE",
  help: `MESSAGE — текст заметки; '-' означает весь stdin. Пустой текст —
ошибка ввода.

Отправка идёт от имени бота (Bot API), а не от твоего аккаунта. Отсюда
два следствия, ради которых команда и заведена: чат с ботом не виден
командам mpu telegram ls и mpu telegram search, а текст заметки не
попадает в журнал вызовов — в записи он заменён на REDACTED.

Адресат единственный и берётся из TELEGRAM_BOT_ID; опции выбора чата
нет намеренно: динамический адресат означал бы, что сообщение может
уйти постороннему, написавшему боту.

stdout — одна строка JSON: {"id": …}.

Ключи env-файла: TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_ID (обязательны),
TELEGRAM_BOT_NAME (необязателен, попадает в подсказку при отказе).
Ключи сеанса MTProto команде не нужны.

Exit: 0 — успех; 1 — конфигурация или отказ Bot API; 2 — ошибка ввода.

Пример: mpu telegram log 'деплой упал, посмотреть утром'`,
  policy: "rw",
  logsArguments: false,
  argsSchema,
  forms: {
    message: { positional: "one" },
  },
  resultSchema,
  run: runTelegramLog,
  render: (result: LogResult) => `{"id": ${result.id}}\n`,
});
```

Поле `logsArguments: false` введено в Task 4, поэтому свойство уже легально и типы сходятся сразу.

- [ ] **Step 5: Запустить тест разбора ввода**

Run: `cd ts && deno test --allow-read --allow-write --allow-env src/telegram/cmd_log_test.ts`
Expected: PASS, 4 теста.

- [ ] **Step 6: Зарегистрировать команду**

В `ts/src/telegram/mod.ts` добавить экспорт в алфавитном порядке (перед `telegramLsCommand`):

```ts
export { telegramLogCommand } from "./cmd_log.ts";
```

В `ts/src/registry/mod.ts` добавить `telegramLogCommand` в импорт из `"../telegram/mod.ts"` (строки 75-79) и в список регистрации (строки 180-183), рядом с `telegramSendCommand`.

- [ ] **Step 7: Добавить образец вызова в контракт-тест**

В `ts/src/registry/contract_test.ts` после блока `path: "telegram send"` добавить:

```ts
  {
    path: "telegram log",
    // Ключей бота в env-файле обхода нет: вызов обязан отбиться на
    // конфигурации, до сети.
    argv: ["заметка"],
    sampleResult: { id: 5000001 },
  },
```

- [ ] **Step 8: Прогнать тесты реестра**

Run: `cd ts && deno test --allow-read --allow-write --allow-env --allow-net=127.0.0.1 src/registry/`
Expected: PASS. Разошедшуюся golden-фикстуру справки обновить в обеих копиях одинаково: канал `docs/specs/fixtures/platform/registry/help-list.txt` и копия `src/registry/testdata/help-list.txt`.

- [ ] **Step 9: Commit**

Добавить `ts/src/telegram/cmd_log.ts`, `ts/src/telegram/cmd_log_test.ts`, `ts/src/telegram/mod.ts`, `ts/src/registry/`, `ts/docs/specs/fixtures/platform/registry/`, сообщение:

```
feat(telegram): команда telegram log — заметка себе через личного бота
```

---

### Task 6: Golden-фикстуры и профиль MCP

**Files:**
- Create: `ts/docs/specs/fixtures/telegram-log/log-stdout.txt`
- Create: `ts/docs/specs/fixtures/telegram-log/err-empty-text-stderr.txt`
- Create: `ts/src/telegram/testdata/telegram-log/log-stdout.txt`
- Create: `ts/src/telegram/testdata/telegram-log/err-empty-text-stderr.txt`
- Modify: `ts/src/telegram/fixtures_test.ts`
- Modify: `ts/docs/specs/fixtures/mcp-server/tool-policies.json`

**Interfaces:**
- Consumes: пометку из Task 4 и команду из Task 5 — фикстуры снимаются с готового поведения.
- Produces: golden-пару, которую сверяет `fixtures_test.ts`.

- [ ] **Step 1: Создать эталон stdout**

Оба файла `log-stdout.txt` (канал и копия) — байт-в-байт одинаковые: одна строка, оканчивающаяся переводом строки (как у соседей — проверить `od -c src/telegram/testdata/telegram-send/send-text-stdout.txt`). Пробел после двоеточия обязателен: вывод собирается шаблоном `render`, а не `JSON.stringify`.

```
{"id": 5000001}
```

- [ ] **Step 2: Создать эталон stderr пустого текста**

Оба файла `err-empty-text-stderr.txt` — одна строка с переводом строки в конце (эталон соседа `telegram-send/err-empty-text-stderr.txt` оканчивается `\n`):

```
telegram: нужен непустой MESSAGE
```

- [ ] **Step 3: Зарегистрировать набор в сверке копий**

В `ts/src/telegram/fixtures_test.ts` в массив `SETS` добавить (порядок имён — алфавитный, как у соседей):

```ts
  {
    channel: "telegram-log",
    copy: "telegram-log/",
    names: [
      "err-empty-text-stderr.txt",
      "log-stdout.txt",
    ],
  },
```

- [ ] **Step 4: Запустить сверку фикстур**

Run: `cd ts && deno test --allow-read --allow-write --allow-env src/telegram/fixtures_test.ts`
Expected: PASS — копии совпадают с каналом байт-в-байт.

- [ ] **Step 5: Добавить тул в rw-профиль**

В `ts/docs/specs/fixtures/mcp-server/tool-policies.json` добавить `"telegram log"` рядом с `"telegram send"` — проверить оба вхождения `"telegram send"` в файле (~строки 73 и 125) и понять по структуре, какое из них список rw-профиля, а какое иное перечисление. В ro-профиль команда не попадает: она отправляет сообщение.

- [ ] **Step 6: Прогнать тесты MCP**

Run: `cd ts && deno test --allow-read --allow-write --allow-env --allow-net=127.0.0.1 src/mcp/`
Expected: PASS. Если разошлась golden-копия `tools-ro.json` — проверить, что команда там НЕ появилась; её присутствие в ro-профиле означает ошибку в шаге 5.

- [ ] **Step 7: Полный прогон**

Run: `cd ts && deno task test && deno check main.ts && deno fmt --check`
Expected: всё зелёное.

- [ ] **Step 8: Commit**

Добавить `ts/docs/specs/fixtures/telegram-log/`, `ts/docs/specs/fixtures/mcp-server/tool-policies.json`, `ts/src/telegram/testdata/telegram-log/`, `ts/src/telegram/fixtures_test.ts`, `ts/src/mcp/`, сообщение:

```
test(telegram): golden-фикстуры telegram log и тул в rw-профиле
```

---

### Task 7: Проверка на живом канале

Единственный шаг, который нельзя закрыть тестами: ключи в env-файле принадлежат оператору, и подтвердить доставку может только он. Шаги 2-4 выполняет человек — агент их не запускает, а просит выполнить и дожидается ответа.

**Files:** изменений кода нет.

**Interfaces:**
- Consumes: собранный бинарь и env-файл оператора.
- Produces: подтверждение, что канал работает и текст в журнал не попадает.

- [ ] **Step 1: Собрать бинарь**

Run: `cd ts && deno task build`
Expected: бинарь в `$HOME/.local/bin/mpu`.

- [ ] **Step 2: Отправить пробное сообщение**

Run: `mpu telegram log 'проверка канала'`
Expected: stdout `{"id":…}`; сообщение пришло в Telegram от бота.

- [ ] **Step 3: Убедиться, что текст не попал в журнал**

Run: `mpu log --tail 1`
Expected: запись есть, строка команды — `$ mpu telegram log REDACTED`.

Run: `grep -c 'проверка канала' ~/.config/mpu/mpu.log`
Expected: `0`.

- [ ] **Step 4: Проверить отказ без конфигурации**

Run: `env -i HOME=$HOME XDG_CONFIG_HOME=/tmp/empty-config mpu telegram log 'x'; echo "exit=$?"`
Expected: `telegram: environment variable TELEGRAM_BOT_TOKEN is not set.…` и `exit=1`.

- [ ] **Step 5: Сверить спеку с наблюдаемым поведением**

Прочитать `ts/docs/specs/telegram-log.md` и сверить с тем, что показали шаги 2-4. Расхождение в поведении исправляется в коде: спека — источник истины (`ts/docs/CLAUDE.md`). Случай, где неверна сама спека, — повод остановиться и спросить, а не править её молча.

После успешной сверки перевести строку статуса спеки из `к реализации` в `реализовано`. Правку статуса вносит сессия-спецификатор — та же, что писала Task 1.

- [ ] **Step 6: Commit, если правки были**

Добавить затронутые пути `ts/src` и `ts/docs/specs`, сообщение:

```
fix(telegram): telegram log приведена в соответствие спеке
```

Если правок не было — коммита нет.
