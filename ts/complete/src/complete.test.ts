/**
 * `mpu-complete` (`specs/complete.md`): случаи таблицы на снимке-фикстуре,
 * скрипты подключения — эталоны, bash не режет слово с `:`, отказы и
 * «нет снимка — нет вариантов».
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { closedPort } from "../../back/src/testing/http.ts";
import {
  askBack,
  complete,
  type CompleteProcess,
  fromSnapshot,
  initScript,
  runComplete,
} from "./mod.ts";
import { withBack } from "../../back/src/backend/testback.ts";
import { allowEverything } from "../../back/src/line/testconsent.ts";
import table from "./testdata/complete/cases.json" with { type: "json" };

const DATA = new URL("testdata/complete/", import.meta.url);
const tree = () => readFile(new URL("tree.json", DATA), "utf8");

interface Case {
  readonly name: string;
  readonly words: readonly string[];
  readonly output: string;
}

describe("случаи таблицы на снимке-фикстуре", () => {
  let snapshot: string;
  beforeAll(async () => {
    snapshot = await tree();
  });

  for (const one of table.cases satisfies readonly Case[]) {
    it(one.name, () => {
      expect(complete(one.words, snapshot)).toStrictEqual(one.output);
    });
  }
});

/** Прогон процесса с подставленным чтением снимка; `back` не отвечает. */
async function run(
  args: readonly string[],
  snapshot = "",
  back: CompleteProcess["back"] = () => Promise.resolve(undefined),
) {
  const out: string[] = [];
  const err: string[] = [];
  const read: string[] = [];
  const code = await runComplete(args, {
    snapshotPath: "/home/test/.cache/mpu/tree.json",
    read: (path) => {
      read.push(path);
      return Promise.resolve(snapshot);
    },
    back,
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  });
  return { code, stdout: out.join(""), stderr: err.join(""), read };
}

it("нет снимка или мусор — пусто, код 0", async () => {
  for (const snapshot of [
    "",
    "{",
    "[]",
    '{"nodes": 5}',
    '{"nodes": [1, "x"]}',
  ]) {
    expect(await run(["--", ""], snapshot)).toStrictEqual({
      code: 0,
      stdout: "",
      stderr: "",
      read: ["/home/test/.cache/mpu/tree.json"],
    });
  }
});

it("--snapshot заменяет путь; без -- — код 2", async () => {
  const snapshot = await tree();
  const other = await run(["--snapshot", "/tmp/x.json", "--", "ki"], snapshot);
  expect(other.read).toStrictEqual(["/tmp/x.json"]);
  expect(other.stdout.startsWith("kiten\t")).toBe(true);
  for (const args of [
    [],
    ["ki"],
    ["--snapshot", "/x"],
    ["--что-то", "--", "x"],
  ]) {
    expect(await run(args), args.join(" ")).toStrictEqual({
      code: 2,
      stdout: "",
      stderr: "mpu-complete: нужен -- и слова\n",
      read: [],
    });
  }
});

it("init: bash, fish, nu — эталоны; zsh — код 2; --command", async () => {
  const files = {
    bash: "init-bash.sh",
    fish: "init-fish.fish",
    nu: "init-nu.nu",
  };
  for (const [shell, file] of Object.entries(files)) {
    const printed = await run(["init", shell]);
    expect(printed.code).toBe(0);
    expect(printed.stdout).toStrictEqual(
      await readFile(new URL(file, DATA), "utf8"),
    );
  }
  expect(await run(["init", "zsh"])).toStrictEqual({
    code: 2,
    stdout: "",
    stderr: "mpu-complete: оболочка zsh не поддерживается (bash, fish, nu)\n",
    read: [],
  });
  const named = await run(["init", "fish", "--command", "mpu-dev"]);
  expect(named.stdout.includes("complete -c mpu-dev ")).toBe(true);
});

it("--version — версия, снимок не читается", async () => {
  expect(await run(["--version"])).toStrictEqual({
    code: 0,
    stdout: "0.1.0\n",
    stderr: "",
    read: [],
  });
});

/**
 * bash со скриптом подключения и заглушкой `mpu-complete`: переменные
 * дополнения — как их ставит bash для строки `line` с курсором в конце.
 */
async function bashComplete(line: string, words: string[], answer: string) {
  // Скрипт — из кода, а не эталон: проверяется то, что печатает `init`.
  const script = initScript("bash", "mpu-dev");
  const program = `
${script}
mpu-complete() { local IFS=' '; printf '%s\\n' "$*" >&2; printf '${answer}'; }
COMP_LINE=${JSON.stringify(line)}
COMP_POINT=\${#COMP_LINE}
COMP_WORDS=(${words.map((word) => JSON.stringify(word)).join(" ")})
COMP_CWORD=${words.length - 1}
_mpu_dev_complete
printf '%s\\n' "\${COMPREPLY[@]}"
`;
  // Код выхода bash не проверяется — как и прежде: важны только потоки.
  const output = await new Promise<{ stdout: string; stderr: string }>(
    (resolve) =>
      execFile("/bin/bash", ["-c", program], (_failed, stdout, stderr) =>
        resolve({ stdout, stderr }),
      ),
  );
  const decode = (text: string) => text.split("\n").filter((row) => row !== "");
  return { replies: decode(output.stdout), asked: decode(output.stderr) };
}

it("bash: слово с «:» не разрезается, ответ — без набранного до «:»", async () => {
  // bash разрезал «seller-id:12» по ':' на три слова.
  const glued = await bashComplete(
    "mpu-dev ozon-loader seller-id:12",
    ["mpu-dev", "ozon-loader", "seller-id", ":", "12"],
    "seller-id:123\\tописание\\n",
  );
  expect(glued.asked).toStrictEqual(["-- ozon-loader seller-id:12"]);
  expect(glued.replies).toStrictEqual(["123"]);
  const plain = await bashComplete(
    "mpu-dev ki",
    ["mpu-dev", "ki"],
    "kiten\\tкарточки\\n",
  );
  expect(plain.asked).toStrictEqual(["-- ki"]);
  expect(plain.replies).toStrictEqual(["kiten"]);
  const empty = await bashComplete(
    "mpu-dev kiten ",
    ["mpu-dev", "kiten", ""],
    "card\\tx\\nls\\ty\\n",
  );
  expect(empty.asked).toStrictEqual(["-- kiten "]);
  expect(empty.replies).toStrictEqual(["card", "ls"]);
});

it("back ответил — его варианты, снимок не читается", async () => {
  const asked: string[] = [];
  const answered = await run(["--", "kiten", ""], await tree(), (line) => {
    asked.push(line);
    return Promise.resolve([{ value: "zzz", summary: "от back" }]);
  });
  expect(asked).toStrictEqual(["kiten "]);
  expect(answered.stdout).toBe("zzz\tот back\n");
  expect(answered.read).toStrictEqual([]);
});

it("askBack: живой back — ответ complete:, по его дереву", () =>
  withBack(async (back) => {
    const choices = await askBack("xlsx al", {
      base: back.url,
      token: back.token,
      fetch,
      deadline: () => AbortSignal.timeout(5000),
    });
    expect(choices?.map((choice) => choice.value)).toStrictEqual(["alias"]);
    expect(back.called).toStrictEqual([]);
  }));

it("askBack: back не запущен — нет ответа, причина — отказ соединения", async () => {
  // Порт от ОС, слушатель закрыт до запроса: соединение отказывается.
  const port = await closedPort();
  const started = performance.now();
  const choices = await askBack("ki", {
    base: `http://127.0.0.1:${port}`,
    token: "t",
    fetch,
    deadline: () => AbortSignal.timeout(150),
  });
  expect(choices).toStrictEqual(undefined);
  expect(performance.now() - started < 150).toBe(true);
});

it("askBack: back не успел — срок истёк, нет ответа", async () => {
  const deadline = new AbortController();
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("истёк", "TimeoutError")),
      );
    });
  const pending = askBack("ki", {
    base: "http://127.0.0.1:1",
    token: "t",
    fetch: hanging,
    deadline: () => deadline.signal,
  });
  deadline.abort();
  expect(await pending).toStrictEqual(undefined);
});

it("askBack: нет основного токена — back не спрашивается", async () => {
  let fetched = 0;
  const choices = await askBack("ki", {
    base: "http://127.0.0.1:1",
    token: undefined,
    fetch: () => {
      fetched++;
      return Promise.reject(new TypeError("не должно"));
    },
    deadline: () => AbortSignal.timeout(150),
  });
  expect([choices, fetched]).toStrictEqual([undefined, 0]);
});

/**
 * Слова корня строки, которых в снимке нет по устройству: вход в дверь
 * (снимок — дерево без `ask`, 157), само дополнение, `it` и методы корня,
 * которые даёт строке сервер (`web`, `web-logout`), а не реестр.
 */
const LINE_ONLY: ReadonlySet<string> = new Set([
  "ask",
  "complete:",
  "it",
  "web",
  "web-logout",
]);

it("снимок и back на одном дереве — одни и те же слова", () =>
  withBack(async (back) => {
    // Снимок правил не знает: сравнение — при правилах «разрешено всё»,
    // иначе обычный взгляд back не называет пишущих команд.
    allowEverything(back.policyFile);
    const snapshot = await readFile(back.snapshotFile, "utf8");
    for (const line of [
      "",
      "ki",
      "kiten ",
      "kiten card ",
      "kiten card id: 1 ",
      "kiten card id: 1 end ",
      "sql-ro target: 54 ",
      "sql-ro target: 54 --d",
      "logs ",
      "logs portainer ",
      "run-js ssh dry ",
      "sql-ro ",
      "ozon-jobs show ",
      "ozon-jobs show print ",
    ]) {
      const fromBack = await askBack(line, {
        base: back.url,
        token: back.token,
        fetch,
        deadline: () => AbortSignal.timeout(5000),
      });
      const words = (choices: readonly { value: string }[] | undefined) =>
        (choices ?? [])
          .map((choice) => choice.value)
          .filter((word) => !LINE_ONLY.has(word))
          .sort();
      expect(words(fromBack), JSON.stringify(line)).toStrictEqual(
        words(fromSnapshot(line.split(" "), snapshot)),
      );
    }
  }));

describe("askBack: ответ не по контракту — нет ответа", () => {
  const answer =
    (status: number, body: string): typeof fetch =>
    () =>
      Promise.resolve(new Response(body, { status }));
  for (const [name, reply] of [
    ["401", answer(401, "")],
    ["вопрос вместо ответа", answer(200, '{"ask":"выполнить? "}\n')],
    ["не ноль", answer(200, '{"out":"[]"}\n{"exit":2}\n')],
    ["не массив", answer(200, '{"out":"{}"}\n{"exit":0}\n')],
    ["не JSON", answer(200, '{"out":"x"}\n{"exit":0}\n')],
    ["чужой кадр", answer(200, '{"x":1,"y":2}\n')],
    ["без кода", answer(200, '{"out":"[]"}\n')],
  ] as const) {
    it(name, async () => {
      expect(
        await askBack("ki", {
          base: "http://127.0.0.1:1",
          token: "t",
          fetch: reply,
          deadline: () => new AbortController().signal,
        }),
      ).toStrictEqual(undefined);
    });
  }
});
