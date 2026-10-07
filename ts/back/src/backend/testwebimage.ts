/**
 * Стенд экранов образа (`web-image.md`, «Сценарии»): `back` с `HOME` во
 * временном каталоге и часами-переменной, сессия браузера cookie, «три
 * метода» строками основного токена. Им пользуются тесты сценариев и
 * пересборка голденов `testdata/web/*-image.json`.
 */

import { strictEqual } from "node:assert/strict";
import { DEFINED_AT } from "../line/testimage.ts";
import { collected, type Frame, type TestBack, withBack } from "./testback.ts";

/** Часы строк сценариев — после определения «трёх методов». */
export const LINES_AT = "2026-09-24T09:00:00.000Z";

/** «Три метода» (`image-sync.md`, «Сценарии»). */
export const THREE: readonly string[] = [
  "ask kiten define: cardsIn purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
  "ask kiten define: mine purpose: ^мои^ do kiten ls done",
  "ask kiten define: shipped purpose: ^готово^ do kiten ls where: column is: Готово done",
];

/** Стенд одного сценария. */
export interface WebImage {
  readonly back: TestBack;
  /** `HOME` стенда. */
  readonly home: string;
  /** Каталог образа по умолчанию, `$H/mr/mp/mpu/image`. */
  readonly dir: string;
  /** Строка экрана: cookie, `human: true`; собранный ответ. */
  screen(words: readonly string[]): Promise<Frame>;
  /** Ответ на вопрос строки экрана по номеру. */
  answer(asked: Frame, answer: "y" | "n"): Promise<Frame>;
  /**
   * Строка из терминала основным токеном, с ответами по очереди; текст —
   * слова через пробел.
   */
  terminal(
    line: string | readonly string[],
    answers?: readonly string[],
  ): Promise<Frame>;
  /** Метод `/rpc` без параметров — `result`. */
  rpc(method: string): Promise<unknown>;
}

const origin = (back: TestBack) =>
  `http://mpu.localhost:${new URL(back.url).port}`;

async function line(
  back: TestBack,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Frame> {
  const response = await fetch(`${back.url}${path}`, {
    method: "POST",
    headers: { ...headers, Accept: "application/json" },
    body: JSON.stringify(body),
  });
  return await collected(back, response);
}

/** Cookie сессии: ключ строкой `web` основным токеном и обмен. */
async function session(back: TestBack): Promise<Record<string, string>> {
  const bearer = { Authorization: `Bearer ${back.token}` };
  const link = await line(back, "/line", bearer, { words: ["web"], cwd: "/" });
  const key = /\?key=([0-9a-f]{32})\n$/.exec(String(link.stdout))?.[1];
  const response = await fetch(`${back.url}/web/session`, {
    method: "POST",
    headers: { Origin: origin(back) },
    body: JSON.stringify({ key }),
  });
  await response.body?.cancel();
  strictEqual(response.status, 204, "обмен ключа");
  const cookie = response.headers.get("Set-Cookie") ?? "";
  return { Cookie: cookie.split(";")[0], Origin: origin(back) };
}

/**
 * Стенд на время `body`: «три метода» определены при `DEFINED_AT`,
 * дальше часы — `LINES_AT`.
 */
export async function withWebImage(
  body: (stand: WebImage) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir();
  let now = Date.parse(DEFINED_AT);
  try {
    await Deno.mkdir(`${home}/mr/mp/mpu`, { recursive: true });
    await withBack(async (back) => {
      const bearer = { Authorization: `Bearer ${back.token}` };
      const terminal = async (
        said: string | readonly string[],
        answers: readonly string[] = [],
      ) => {
        let reply = await line(back, "/line", bearer, {
          words: typeof said === "string" ? said.split(" ") : said,
          cwd: "/",
          human: true,
        });
        for (const answer of answers) {
          if (!("ticket" in reply)) break;
          reply = await line(back, "/line/answer", bearer, {
            ticket: reply.ticket,
            answer,
          });
        }
        return reply;
      };
      for (const said of THREE) {
        const done = await terminal(said, ["y"]);
        strictEqual(done.exit, 0, JSON.stringify(done));
      }
      now = Date.parse(LINES_AT);
      const cookie = await session(back);
      await body({
        back,
        home,
        dir: `${home}/mr/mp/mpu/image`,
        screen: (words) =>
          line(back, "/line", cookie, { words, cwd: "/", human: true }),
        answer: (asked, answer) =>
          line(back, "/line/answer", cookie, { ticket: asked.ticket, answer }),
        terminal,
        rpc: async (method) => {
          const response = await fetch(`${back.url}/rpc`, {
            method: "POST",
            headers: bearer,
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
          });
          const text = await response.text();
          back.seen.push(text);
          return JSON.parse(text).result;
        },
      });
    }, {
      now: () => now,
      io: { env: (name) => name === "HOME" ? home : undefined },
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

/** Голдены стенда сценария 1: ответы `tree.snapshot` и `policy.tree`. */
export async function webImageGoldens(): Promise<{
  snapshot: unknown;
  policyTree: unknown;
}> {
  let taken = {
    snapshot: undefined as unknown,
    policyTree: undefined as unknown,
  };
  await withWebImage(async (stand) => {
    taken = {
      snapshot: await stand.rpc("tree.snapshot"),
      policyTree: await stand.rpc("policy.tree"),
    };
  });
  return taken;
}
