/**
 * Итог строки по WebSocket равен итогу прямого исполнения на тех же словах,
 * правилах и ответе (`platform/back-rpc.md`, инвариант второй). Эталон —
 * живой прогон `lineEntry` в том же тесте; вопрос у него — событие `ask`,
 * вывод — события `out`/`err` в порядке появления, код — `exit`. Копия
 * эталона лежит в `testdata/back-rpc/frames-*.json`.
 */

import { GRAMMAR } from "../messages/mod.ts";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { IN_PLACE, type InvokeJournal } from "../entrypoint/mod.ts";
import {
  HUMAN_ONLY,
  immediately,
  IN_PLACE_PROGRAMS,
  lineEntry,
  NO_CALLER,
  programFiles,
  rulesOf,
} from "../line/mod.ts";
import { withPolicyFile } from "../line/testconsent.ts";
import { Agent, type Channel, Human, NOBODY } from "../policy/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  Client,
  type Frame,
  line,
  refusalFrame,
  withBack,
} from "./testback.ts";

interface Case {
  readonly name: string;
  readonly path: "/line" | "/agent/line";
  readonly words: readonly string[];
  readonly answers: readonly string[];
  readonly human: boolean;
}

const CASES: readonly Case[] = [
  {
    name: "version",
    path: "/line",
    words: ["version"],
    answers: [],
    human: true,
  },
  { name: "kitn", path: "/line", words: ["kitn"], answers: [], human: true },
  {
    name: "allow-human",
    path: "/line",
    words: ["allow:", "kiten ls"],
    answers: ["y"],
    human: true,
  },
  {
    name: "allow-agent",
    path: "/agent/line",
    words: ["allow:", "kiten ls"],
    answers: ["y"],
    human: true,
  },
  {
    name: "ask-nobody",
    path: "/line",
    words: ["ask", "kiten", "comment", "id:", "1", "text:", "x"],
    answers: [],
    human: false,
  },
  {
    name: "xlsx-alias-ls",
    path: "/line",
    words: ["xlsx", "alias", "ls", GRAMMAR.close, "json"],
    answers: [],
    human: true,
  },
];

/** Прямое исполнение строки с тем же каналом и теми же ответами. */
async function directFrames(one: Case, file: string) {
  const frames: Frame[] = [];
  const called: string[] = [];
  const queue = [...one.answers];
  const client: Channel = one.human
    ? new Human(
      (question) => void frames.push({ ask: question }),
      () => Promise.resolve(queue.shift()),
    )
    : NOBODY;
  const channel = one.path === "/agent/line" ? new Agent(client) : client;
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const code = await lineEntry({
    file,
    files: programFiles(() => undefined),
    channel: () => channel,
    execute: immediately,
    invoker: IN_PLACE,
    evaluator: IN_PLACE_PROGRAMS,
    rootMethods: [],
    memory: NO_CALLER,
    refusal: (data) => void frames.push({ refusal: data }),
  })(one.words, makeFakeIo(), {
    stdout: (text) => void frames.push({ out: text }),
    stderr: (text) => void frames.push({ err: text }),
  }, journal);
  frames.push({ exit: code });
  return { frames, called, rules: rulesOf(file) };
}

describe("кадры строки равны прямому исполнению", () => {
  for (const one of CASES) {
    it(one.name, () =>
      withPolicyFile((file) =>
        withBack(async (back) => {
          const expected = await directFrames(one, file);
          const frames = await line(
            back,
            one.path,
            one.words,
            one.answers,
            one.human,
          );
          expect(frames).toStrictEqual(expected.frames);
          expect(back.called).toStrictEqual(expected.called);
          expect(rulesOf(back.policyFile)).toStrictEqual(expected.rules);
          const golden = new URL(
            `testdata/back-rpc/frames-${one.name}.json`,
            import.meta.url,
          );
          expect(frames).toStrictEqual(
            JSON.parse(await readFile(golden, "utf8")),
          );
        })
      ));
  }
});

it("правило: человек меняет, агент — нет, файл агента не тронут", () =>
  withBack(async (back) => {
    await line(back, "/line", ["version"]);
    const before = await readFile(back.policyFile);
    const agent = await line(back, "/agent/line", ["allow:", "kiten ls"], [
      "y",
    ]);
    expect(agent).toStrictEqual([
      refusalFrame(HUMAN_ONLY, HUMAN_ONLY),
      { err: "изменить правила может только человек\n" },
      { exit: 1 },
    ]);
    expect(await readFile(back.policyFile)).toStrictEqual(before);
    const human = await line(back, "/line", ["allow:", "kiten ls"], ["y"]);
    expect(human[0]).toStrictEqual({
      ask: "изменить правило: kiten ls → allow? [y/N] ",
    });
    expect(human.at(-1)).toStrictEqual({ exit: 0 });
    expect(rulesOf(back.policyFile).find((rule) => rule.path === "kiten ls"))
      .toStrictEqual({ path: "kiten ls", verdict: "allow" });
  }));

it("ask без человека: отказ, команда не вызвана", () =>
  withBack(async (back) => {
    const frames = await line(
      back,
      "/line",
      ["ask", "kiten", "comment", "id:", "1", "text:", "x"],
      ["y"],
      false,
    );
    expect(frames.at(-1)).toStrictEqual({ exit: 1 });
    expect(frames.some((frame) => "ask" in frame)).toBe(false);
    expect(back.called).toStrictEqual([]);
  }));

describe("плохой первый кадр и нет каталога — отказ с кодом 2", () => {
  const cases: readonly (readonly [string, unknown, readonly Frame[]])[] = [
    ["не JSON", "{", [{ err: "mpu-back: плохой кадр строки\n" }, { exit: 2 }]],
    ["нет cwd", { words: ["version"] }, [
      { err: "mpu-back: плохой кадр строки\n" },
      { exit: 2 },
    ]],
    ["human не булево", { words: ["version"], cwd: "/", human: "да" }, [
      { err: "mpu-back: плохой кадр строки\n" },
      { exit: 2 },
    ]],
    ["words не строки", { words: [1], cwd: "/" }, [
      { err: "mpu-back: плохой кадр строки\n" },
      { exit: 2 },
    ]],
    ["cwd относительный", { words: ["version"], cwd: "tmp" }, [
      { err: "mpu-back: плохой кадр строки\n" },
      { exit: 2 },
    ]],
    ["нет каталога", { words: ["version"], cwd: "/нет/такого" }, [
      { err: "mpu-back: нет каталога /нет/такого\n" },
      { exit: 2 },
    ]],
  ];
  for (const [name, first, expected] of cases) {
    it(name, () =>
      withBack(async (back) => {
        const client = new Client(back, "/line");
        await client.opened();
        client.send(first);
        expect(await client.finished()).toStrictEqual(expected);
        expect(back.called).toStrictEqual([]);
      }));
  }
});
