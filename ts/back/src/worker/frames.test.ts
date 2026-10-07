/**
 * Кодек кадров ядро ↔ исполнитель (`platform/line-executor.md`, «Пул и
 * протокол»): строка NDJSON туда и обратно, чужое — отказ разбора.
 */

import { describe, expect, it } from "vitest";
import {
  BadWorkerFrame,
  encode,
  type HostFrame,
  hostFrameOf,
  type WorkerFrame,
  workerFrameOf,
} from "./frames.ts";

describe("кадры: строка NDJSON разбирается в тот же кадр", () => {
  const host: readonly HostFrame[] = [
    {
      run: {
        path: ["kiten", "ls"],
        args: ["--json"],
        cwd: "/work",
        context: { tty: { stdin: false, stdout: true, stderr: true } },
      },
    },
    { answer: "y" },
    { answer: null },
    { stdin: "ввод\n" },
    { stop: true },
    {
      evaluate: {
        words: ["x", ":=", "5"],
        methods: [],
        source: null,
        params: null,
      },
    },
    {
      evaluate: {
        words: ["kiten", "mine"],
        methods: [{
          receiver: ["kiten"],
          name: "mine",
          source: ["do", "kiten", "ls", "done"],
        }],
        source: "stdin",
        params: null,
      },
    },
    {
      lined: {
        data: { rows: [] },
        command: { path: ["kiten", "ls"], argv: ["column:", "9101"] },
        shown: "(0 cards)\n",
      },
    },
    { lined: { data: "0.1.0", command: null, shown: "0.1.0\n" } },
    { lined: { exit: 2 } },
  ];
  const worker: readonly WorkerFrame[] = [
    { out: "да\n" },
    { err: "нет\n" },
    { progress: "шаг" },
    { note: "повтор" },
    { ask: { kind: "secret", text: "Пароль: " } },
    { stdin: true },
    { result: { value: { a: 1 } } },
    { result: { code: 2, stderr: "mpu x: плохо" } },
    { result: { crash: "сломалось" } },
    { line: ["kiten", "ls"] },
    { result: { exit: 0, refusal: null } },
    {
      result: {
        exit: 1,
        refusal: {
          reason: "не понимает",
          hint: ["x", "title"],
          candidates: ["title"],
          text: "выражение 1: запись не понимает titel; ближайшие: title",
        },
      },
    },
  ];
  for (const frame of host) {
    it(JSON.stringify(frame), () => {
      const line = encode(frame);
      expect(line.endsWith("\n") && !line.slice(0, -1).includes("\n")).toBe(
        true,
      );
      expect(hostFrameOf(line.trimEnd())).toStrictEqual(frame);
    });
  }
  for (const frame of worker) {
    it(JSON.stringify(frame), () => {
      expect(workerFrameOf(encode(frame).trimEnd())).toStrictEqual(frame);
    });
  }
});

it("кадры: результат undefined — значение без поля", () => {
  expect(workerFrameOf(encode({ result: { value: undefined } }).trimEnd()))
    .toStrictEqual({ result: { value: undefined } });
});

it("кадр evaluate без source — набранная строка", () => {
  expect(hostFrameOf('{"evaluate": {"words": ["x"], "methods": []}}'))
    .toStrictEqual({
      evaluate: { words: ["x"], methods: [], source: null, params: null },
    });
});

describe("кадры: чужое — отказ разбора своей стороны", () => {
  const bad: readonly [string, (line: string) => unknown][] = [
    ["не json", hostFrameOf],
    ["[1]", workerFrameOf],
    [
      '{"run": {"path": ["x"], "args": [1], "cwd": "/", "context": {}}}',
      hostFrameOf,
    ],
    ['{"run": {"path": ["x"], "args": [], "context": {}}}', hostFrameOf],
    ['{"out": "кадр исполнителя"}', hostFrameOf],
    ['{"ask": {"kind": "shout", "text": "?"}}', workerFrameOf],
    ['{"result": {"code": 3, "stderr": "?"}}', workerFrameOf],
    ['{"stop": true}', workerFrameOf],
    ['{"lined": {"data": 1, "command": null}}', hostFrameOf],
    ['{"lined": {"data": 1, "command": 5, "shown": ""}}', hostFrameOf],
    ['{"evaluate": {"words": [1]}}', hostFrameOf],
    ['{"evaluate": {"words": [], "methods": [], "source": 1}}', hostFrameOf],
    [
      '{"evaluate": {"words": [], "methods": [], "params": {"col": 1}}}',
      hostFrameOf,
    ],
    ['{"line": "kiten ls"}', workerFrameOf],
    ['{"result": {"exit": 1, "refusal": {"reason": 1}}}', workerFrameOf],
  ];
  for (const [line, parse] of bad) {
    it(line, () => {
      expect(() => parse(line)).toThrow(BadWorkerFrame);
    });
  }
});
