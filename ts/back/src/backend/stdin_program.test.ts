/**
 * Ввод строки без слов у сервера (`platform/stage6-l1.md`; запрос ввода —
 * `platform/stdin-on-request.md`): одно правило у `POST /line` и у обеих
 * дверей WebSocket — слова во вводе — прежняя форма, отказ кодом 2 без
 * исполнения; ввода нет — справка корня. Строка со словами ввода не просит.
 */

import { expect, it } from "vitest";
import { Client, type Frame, httpLine, line, withBack } from "./testback.ts";

/** Отказ прежней форме `stdin`, как его печатает ядро. */
const REFUSED =
  "mpu: stdin — не команда mpu: одна строка — одна команда (путь → " +
  "варианты → ключи → end → формат); несколько команд — отдельными " +
  "вызовами mpu или сценарием mpu-flow; справка — mpu help\n";

/** Кадры строки `words` по сокету; ввод — ответом на `stdinRequest`. */
async function piped(
  path: string,
  words: readonly string[],
  stdin: string,
): Promise<Frame[]> {
  let frames: Frame[] = [];
  await withBack(async (back) => {
    const client = new Client(back, path, { stdin });
    await client.opened();
    client.send({
      words,
      cwd: process.cwd(),
      human: path === "/line",
      stdinOnRequest: true,
    });
    frames = await client.finished();
  });
  return frames;
}

/** Кадры без отказа-объекта: его форму сторожит `refusal-object`. */
function plain(frames: readonly Frame[]): Frame[] {
  return frames.filter((frame) => !("refusal" in frame));
}

it("POST /line без слов: слова во вводе — отказ, без ввода и BOM — справка", () =>
  withBack(async (back) => {
    const cwd = process.cwd();
    const [refused] = await httpLine(back, "/line", {
      words: [],
      stdin: "kiten ls",
      cwd,
    });
    expect(plain(refused)).toStrictEqual([{ err: REFUSED }, { exit: 2 }]);
    const help = await httpLine(back, "/line", { words: ["help"], cwd });
    expect(await httpLine(back, "/line", { words: [], cwd })).toStrictEqual(
      help,
    );
    expect(
      await httpLine(back, "/line", { words: [], stdin: "﻿ \r\n", cwd }),
    ).toStrictEqual(help);
  }));

it("сокеты /line и /agent/line без слов: ввод запрошен сразу, отказ кодом 2", async () => {
  for (const [path, words] of [
    ["/line", []],
    ["/agent/line", ["ask"]],
  ] as const) {
    expect(plain(await piped(path, words, "kiten ls")), path).toStrictEqual([
      { stdinRequest: true },
      { err: REFUSED },
      { exit: 2 },
    ]);
  }
});

it("сокет /line со словами: ввода не просит", () =>
  withBack(async (back) => {
    const frames = await line(back, "/line", ["version"]);
    expect(frames.some((frame) => "stdinRequest" in frame)).toBe(false);
  }));
