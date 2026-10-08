/**
 * Отмена вызова тула доходит до строки (`platform/mcp-cancel.md`):
 * остановленный вызов рвёт запрос переводчика к `back`, а обрыв чтения
 * ответа и есть отмена строки у `POST`-двери. Эталон — настоящий
 * клиент SDK против настоящей пары `back` + переводчик.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type FakeHttp, serveFetch } from "@mpu/testing";
import type { CommandIo } from "@mpu/command";
import { ASK, RuleBook, RulePath } from "@mpu/command/policy";
import { openCacheDb } from "@mpu/command/store";
import { CANCELLED_CODE } from "../../back/src/backend/stopping.ts";
import { within } from "../../back/src/backend/testback.ts";
import { connect, type Stack, withStack } from "./testkit.ts";

/** Слежение за логами: строка, которая сама не кончается. */
const FOLLOW = ["logs", "follow"];

/** Ответ Loki с одной записью, время которой двигается вперёд. */
function entry(index: number): string {
  return JSON.stringify({
    data: {
      result: [
        {
          stream: { host: "sl-1" },
          values: [
            [
              `${1_754_380_800_000_000_000n + BigInt(index)}`,
              `строка ${index}`,
            ],
          ],
        },
      ],
    },
  });
}

/** Loki на петле: каждый опрос отдаёт новую запись. */
function fakeLoki(): Promise<FakeHttp> {
  let asked = 0;
  return serveFetch(() => new Response(entry(asked++), { status: 200 }));
}

/** Журнал прогона: коды записей и ожидание нужного их числа. */
function journal() {
  const codes: number[] = [];
  const waiting: (() => void)[] = [];
  return {
    codes,
    written: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (codes.length >= count) resolve();
        };
        waiting.push(check);
        check();
      }),
    finishedWith: (code: number) => {
      codes.push(code);
      for (const check of waiting) check();
    },
  };
}

/** Начатые строки: по ним видно, что сервер до строки дошёл. */
function begun() {
  const words: string[][] = [];
  const waiting: (() => void)[] = [];
  return {
    words,
    started: () =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (words.length > 0) resolve();
        };
        waiting.push(check);
        check();
      }),
    begun: (line: readonly string[]) => {
      words.push([...line]);
      for (const check of waiting) check();
    },
  };
}

/** Пара `back` + переводчик, у которой `logs` ходит к Loki на петле. */
async function withFollowing(
  body: (stack: Stack) => Promise<void>,
  hooks: {
    readonly finishedWith?: (code: number) => void;
    readonly begun?: (line: readonly string[]) => void;
  } = {},
): Promise<void> {
  const loki = await fakeLoki();
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const io: Partial<CommandIo> = {
      envFile: {
        get: (name: string) => (name === "LOKI_URL" ? loki.baseUrl : undefined),
        values: () => ({ LOKI_URL: loki.baseUrl }),
        require: (name: string) => {
          if (name === "LOKI_URL") return loki.baseUrl;
          throw new Error(`нет ключа ${name}`);
        },
        set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      },
      openCacheDb: () => openCacheDb(`${dir}/mpu.db`),
    };
    await withStack(body, { io, ...hooks });
  } finally {
    await loki.stop();
    await rm(dir, { recursive: true });
  }
}

it("отмена долгой строки: запись 130, ответа вызову нет", async () => {
  const log = journal();
  const start = begun();
  const sent: string[] = [];
  await withFollowing(
    async (stack) => {
      const client = await connect(stack.url, undefined, undefined, (body) => {
        sent.push(body);
      });
      try {
        const stop = new AbortController();
        const call = client.callTool(
          { name: "mpu", arguments: { words: [...FOLLOW] } },
          undefined,
          { signal: stop.signal },
        );
        // Отменяем, когда сервер уже начал строку: иначе проверялась бы
        // гонка, а не отмена.
        await within(start.started(), 10_000, "строка началась");
        // Причину называет сам клиент — `String(signal.reason)` уходит в
        // уведомление дословно, а текст `AbortError` по умолчанию у
        // рантаймов разный (Deno — «The signal has been aborted», Node и
        // Bun — «This operation was aborted»). Явная причина — та, что в
        // голдене канала: проверяется переводчик, а не рантайм клиента.
        stop.abort(
          new DOMException("The signal has been aborted", "AbortError"),
        );
        // Отменённый вызов ответа не ждёт: клиент получает отказ отмены.
        await expect(call).rejects.toThrow();
        await within(log.written(1), 10_000, "запись журнала");
        // Код 130 ставит `back`, остановив строку (`line-cancel.md`).
        expect(log.codes).toStrictEqual([CANCELLED_CODE]);
        // Голден протокола: чем именно клиент отменяет вызов и что от
        // этого остаётся у переводчика.
        await golden("cancelled.json", {
          описание: "отмена вызова тула: уведомление клиента и его следы",
          уведомление: cancelledOf(sent),
          "код записи журнала": log.codes,
          "ответ вызову": "нет: отменённый запрос ответа не ждёт",
        });
      } finally {
        await client.close();
      }
    },
    { finishedWith: log.finishedWith, begun: start.begun },
  );
});

/** Уведомление об отмене среди отправленного клиентом. */
function cancelledOf(sent: readonly string[]): unknown {
  for (const body of sent) {
    const message = JSON.parse(body) as { method?: string };
    if (message.method === "notifications/cancelled") return message;
  }
  throw new Error(`уведомления об отмене нет среди ${sent.length} запросов`);
}

/** Копия снятого прогоном голдена совпадает с ним. */
async function golden(name: string, body: unknown) {
  const url = new URL(`testdata/mcp-objects/${name}`, import.meta.url);
  expect(body).toStrictEqual(JSON.parse(await readFile(url, "utf8")));
}

it("отмена в ожидании подтверждения: ответа в back нет, записи нет", async () => {
  const log = journal();
  const answers: string[] = [];
  // Запросы переводчика к `back`: по ним видно, ушёл ли ответ на
  // вопрос, — «нет» от имени человека тоже был бы ответом.
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/answer")) answers.push(String(init?.body));
    return fetch(url as URL, init);
  }) as typeof fetch;
  await withStack(
    async (stack) => {
      {
        using book = RuleBook.open(stack.back.policyFile, []);
        book.set(RulePath.parse("xlsx alias ls"), ASK);
      }
      const asked = Promise.withResolvers<void>();
      const client = await connect(stack.url, () => {
        asked.resolve();
        // Человек не отвечает: форму снимает сама отмена вызова.
        return new Promise(() => {}) as never;
      });
      try {
        const stop = new AbortController();
        const call = client.callTool(
          { name: "mpu", arguments: { words: ["ask", "xlsx", "alias", "ls"] } },
          undefined,
          { signal: stop.signal },
        );
        await within(asked.promise, 10_000, "вопрос задан");
        stop.abort();
        await expect(call).rejects.toThrow();
        // Ответа в `back` не уходило вовсе: «нет» от имени человека,
        // который ничего не выбирал, — тоже ответ, и его быть не должно.
        expect(answers.length, answers.join(" | ")).toBe(0);
        // Строка не исполнялась, значит и записи журнала нет — как у
        // любого отказа правил.
        expect(stack.back.called).toStrictEqual([]);
        expect(log.codes).toStrictEqual([]);
      } finally {
        await client.close();
      }
    },
    { finishedWith: log.finishedWith, fetcher },
  );
});

it("отмена после конца строки: итог прежний, второй записи нет", async () => {
  const log = journal();
  await withStack(
    async (stack) => {
      const client = await connect(stack.url);
      try {
        const stop = new AbortController();
        // Команда, а не поверхность: запись журнала пишется на вызов
        // команды (`platform/invoke-log.md`), и считать её у `version`
        // было бы нечего.
        const result = await client.callTool(
          { name: "mpu", arguments: { words: ["xlsx", "alias", "ls"] } },
          undefined,
          { signal: stop.signal },
        );
        await within(log.written(1), 10_000, "запись журнала");
        // Отмена пришла после конца: менять нечего и писать нечего.
        stop.abort();
        expect(log.codes).toStrictEqual([0]);
        expect(typeof result).toBe("object");
      } finally {
        await client.close();
      }
    },
    { finishedWith: log.finishedWith },
  );
});

it("транспорт клиента закрылся: то же, что отмена", async () => {
  const log = journal();
  const start = begun();
  await withFollowing(
    async (stack) => {
      const client = await connect(stack.url);
      const call = client
        .callTool({
          name: "mpu",
          arguments: { words: [...FOLLOW] },
        })
        .catch(() => undefined);
      await within(start.started(), 10_000, "строка началась");
      // Клиент прощается штатно: у Streamable HTTP это `DELETE` сессии
      // (`terminateSession` у SDK), а не только закрытие своих сокетов.
      const transport = client.transport as {
        terminateSession?: () => Promise<void>;
      };
      await transport.terminateSession?.();
      await client.close();
      await call;
      await within(log.written(1), 10_000, "запись журнала");
      expect(log.codes).toStrictEqual([CANCELLED_CODE]);
    },
    { finishedWith: log.finishedWith, begun: start.begun },
  );
});
