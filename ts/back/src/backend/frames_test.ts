/**
 * Итог строки по WebSocket равен итогу `mpu-next` на тех же словах,
 * правилах и ответе (`platform/back-rpc.md`, инвариант второй). Эталон —
 * живой прогон `nextEntry` в том же тесте; вопрос у него — событие `ask`,
 * вывод — события `out`/`err` в порядке появления, код — `exit`. Копия
 * эталона лежит в `testdata/back-rpc/frames-*.json`.
 */

import { assertEquals } from "@std/assert";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { immediately, nextEntry, rulesOf } from "../next/mod.ts";
import { withPolicyFile } from "../next/testconsent.ts";
import { Agent, type Channel, Human, NOBODY } from "../policy/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { Client, type Frame, line, withBack } from "./testback.ts";

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
    words: ["kiten", "comment", "1", "x"],
    answers: [],
    human: false,
  },
  {
    name: "xlsx-alias-ls",
    path: "/line",
    words: ["xlsx", "alias", "ls", "--json"],
    answers: [],
    human: true,
  },
];

/** Прогон `mpu-next` с каналом того же пути и теми же ответами. */
async function nextFrames(one: Case, file: string) {
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
  const code = await nextEntry({
    file,
    channel: () => channel,
    execute: immediately,
    rootMethods: [],
  })(one.words, makeFakeIo(), {
    stdout: (text) => void frames.push({ out: text }),
    stderr: (text) => void frames.push({ err: text }),
  }, journal);
  frames.push({ exit: code });
  return { frames, called, rules: rulesOf(file) };
}

Deno.test("кадры строки равны прогону mpu-next", async (t) => {
  for (const one of CASES) {
    await t.step(
      one.name,
      () =>
        withPolicyFile((file) =>
          withBack(async (back) => {
            const expected = await nextFrames(one, file);
            const frames = await line(
              back,
              one.path,
              one.words,
              one.answers,
              one.human,
            );
            assertEquals(frames, expected.frames);
            assertEquals(back.called, expected.called);
            assertEquals(rulesOf(back.policyFile), expected.rules);
            const golden = new URL(
              `testdata/back-rpc/frames-${one.name}.json`,
              import.meta.url,
            );
            assertEquals(frames, JSON.parse(await Deno.readTextFile(golden)));
          })
        ),
    );
  }
});

Deno.test("правило: человек меняет, агент — нет, файл агента не тронут", () =>
  withBack(async (back) => {
    await line(back, "/line", ["version"]);
    const before = await Deno.readFile(back.policyFile);
    const agent = await line(back, "/agent/line", ["allow:", "kiten ls"], [
      "y",
    ]);
    assertEquals(agent, [
      { err: "изменить правила может только человек\n" },
      { exit: 1 },
    ]);
    assertEquals(await Deno.readFile(back.policyFile), before);
    const human = await line(back, "/line", ["allow:", "kiten ls"], ["y"]);
    assertEquals(human[0], {
      ask: "изменить правило: kiten ls → allow? [y/N] ",
    });
    assertEquals(human.at(-1), { exit: 0 });
    assertEquals(
      rulesOf(back.policyFile).find((rule) => rule.path === "kiten ls"),
      { path: "kiten ls", verdict: "allow" },
    );
  }));

Deno.test("ask без человека: отказ, команда не вызвана", () =>
  withBack(async (back) => {
    const frames = await line(
      back,
      "/line",
      ["kiten", "comment", "1", "x"],
      ["y"],
      false,
    );
    assertEquals(frames.at(-1), { exit: 1 });
    assertEquals(frames.some((frame) => "ask" in frame), false);
    assertEquals(back.called, []);
  }));

Deno.test("плохой первый кадр и нет каталога — отказ с кодом 2", async (t) => {
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
    await t.step(name, () =>
      withBack(async (back) => {
        const client = new Client(back, "/line");
        await client.opened();
        client.send(first);
        assertEquals(await client.finished(), expected);
        assertEquals(back.called, []);
      }));
  }
});
