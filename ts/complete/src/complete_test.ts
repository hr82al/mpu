/**
 * `mpu-complete` (`specs/complete.md`): случаи таблицы на снимке-фикстуре,
 * скрипты подключения — эталоны, bash не режет слово с `:`, отказы и
 * «нет снимка — нет вариантов».
 */

import { assertEquals } from "@std/assert";
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

const DATA = new URL("testdata/complete/", import.meta.url);
const tree = () => Deno.readTextFile(new URL("tree.json", DATA));

interface Case {
  readonly name: string;
  readonly words: readonly string[];
  readonly output: string;
}

Deno.test("случаи таблицы на снимке-фикстуре", async (t) => {
  const { cases } = JSON.parse(
    await Deno.readTextFile(new URL("cases.json", DATA)),
  ) as { cases: readonly Case[] };
  const snapshot = await tree();
  for (const one of cases) {
    await t.step(one.name, () => {
      assertEquals(complete(one.words, snapshot), one.output);
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

Deno.test("нет снимка или мусор — пусто, код 0", async () => {
  for (
    const snapshot of ["", "{", "[]", '{"nodes": 5}', '{"nodes": [1, "x"]}']
  ) {
    assertEquals(await run(["--", ""], snapshot), {
      code: 0,
      stdout: "",
      stderr: "",
      read: ["/home/test/.cache/mpu/tree.json"],
    });
  }
});

Deno.test("--snapshot заменяет путь; без -- — код 2", async () => {
  const snapshot = await tree();
  const other = await run(["--snapshot", "/tmp/x.json", "--", "ki"], snapshot);
  assertEquals(other.read, ["/tmp/x.json"]);
  assertEquals(other.stdout.startsWith("kiten\t"), true);
  for (
    const args of [[], ["ki"], ["--snapshot", "/x"], ["--что-то", "--", "x"]]
  ) {
    assertEquals(await run(args), {
      code: 2,
      stdout: "",
      stderr: "mpu-complete: нужен -- и слова\n",
      read: [],
    }, args.join(" "));
  }
});

Deno.test("init: bash, fish, nu — эталоны; zsh — код 2; --command", async () => {
  const files = {
    bash: "init-bash.sh",
    fish: "init-fish.fish",
    nu: "init-nu.nu",
  };
  for (const [shell, file] of Object.entries(files)) {
    const printed = await run(["init", shell]);
    assertEquals(printed.code, 0);
    assertEquals(printed.stdout, await Deno.readTextFile(new URL(file, DATA)));
  }
  assertEquals(await run(["init", "zsh"]), {
    code: 2,
    stdout: "",
    stderr: "mpu-complete: оболочка zsh не поддерживается (bash, fish, nu)\n",
    read: [],
  });
  const named = await run(["init", "fish", "--command", "mpu-dev"]);
  assertEquals(named.stdout.includes("complete -c mpu-dev "), true);
});

Deno.test("--version — версия, снимок не читается", async () => {
  assertEquals(await run(["--version"]), {
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
  const output = await new Deno.Command("/bin/bash", {
    args: ["-c", program],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes).split("\n").filter((row) => row !== "");
  return { replies: decode(output.stdout), asked: decode(output.stderr) };
}

Deno.test("bash: слово с «:» не разрезается, ответ — без набранного до «:»", async () => {
  // bash разрезал «seller-id:12» по ':' на три слова.
  const glued = await bashComplete(
    "mpu-dev ozon-loader seller-id:12",
    ["mpu-dev", "ozon-loader", "seller-id", ":", "12"],
    "seller-id:123\\tописание\\n",
  );
  assertEquals(glued.asked, ["-- ozon-loader seller-id:12"]);
  assertEquals(glued.replies, ["123"]);
  const plain = await bashComplete(
    "mpu-dev ki",
    ["mpu-dev", "ki"],
    "kiten\\tкарточки\\n",
  );
  assertEquals(plain.asked, ["-- ki"]);
  assertEquals(plain.replies, ["kiten"]);
  const empty = await bashComplete(
    "mpu-dev kiten ",
    ["mpu-dev", "kiten", ""],
    "card\\tx\\nls\\ty\\n",
  );
  assertEquals(empty.asked, ["-- kiten "]);
  assertEquals(empty.replies, ["card", "ls"]);
});

Deno.test("back ответил — его варианты, снимок не читается", async () => {
  const asked: string[] = [];
  const answered = await run(["--", "kiten", ""], await tree(), (line) => {
    asked.push(line);
    return Promise.resolve([{ value: "zzz", summary: "от back" }]);
  });
  assertEquals(asked, ["kiten "]);
  assertEquals(answered.stdout, "zzz\tот back\n");
  assertEquals(answered.read, []);
});

Deno.test("askBack: живой back — ответ complete:, по его дереву", () =>
  withBack(async (back) => {
    const choices = await askBack("xlsx al", {
      base: back.url,
      token: back.token,
      fetch,
      deadline: () => AbortSignal.timeout(5000),
    });
    assertEquals(choices?.map((choice) => choice.value), ["alias"]);
    assertEquals(back.called, []);
  }));

Deno.test("askBack: back не запущен — нет ответа, причина — отказ соединения", async () => {
  // Порт от ОС, слушатель закрыт до запроса: соединение отказывается.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = listener.addr.port;
  listener.close();
  const started = performance.now();
  const choices = await askBack("ki", {
    base: `http://127.0.0.1:${port}`,
    token: "t",
    fetch,
    deadline: () => AbortSignal.timeout(150),
  });
  assertEquals(choices, undefined);
  assertEquals(performance.now() - started < 150, true);
});

Deno.test("askBack: back не успел — срок истёк, нет ответа", async () => {
  const deadline = new AbortController();
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("истёк", "TimeoutError")),
      );
    });
  const pending = askBack("ki", {
    base: "http://127.0.0.1:1",
    token: "t",
    fetch: hanging,
    deadline: () => deadline.signal,
  });
  deadline.abort();
  assertEquals(await pending, undefined);
});

Deno.test("askBack: нет основного токена — back не спрашивается", async () => {
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
  assertEquals([choices, fetched], [undefined, 0]);
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

Deno.test("снимок и back на одном дереве — одни и те же слова", () =>
  withBack(async (back) => {
    // Снимок правил не знает: сравнение — при правилах «разрешено всё»,
    // иначе обычный взгляд back не называет пишущих команд.
    allowEverything(back.policyFile);
    const snapshot = await Deno.readTextFile(back.snapshotFile);
    for (
      const line of [
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
      ]
    ) {
      const fromBack = await askBack(line, {
        base: back.url,
        token: back.token,
        fetch,
        deadline: () => AbortSignal.timeout(5000),
      });
      const words = (choices: readonly { value: string }[] | undefined) =>
        (choices ?? []).map((choice) => choice.value)
          .filter((word) => !LINE_ONLY.has(word)).sort();
      assertEquals(
        words(fromBack),
        words(fromSnapshot(line.split(" "), snapshot)),
        JSON.stringify(line),
      );
    }
  }));

Deno.test("askBack: ответ не по контракту — нет ответа", async (t) => {
  const answer = (status: number, body: string): typeof fetch => () =>
    Promise.resolve(new Response(body, { status }));
  for (
    const [name, reply] of [
      ["401", answer(401, "")],
      ["вопрос вместо ответа", answer(200, '{"ask":"выполнить? "}\n')],
      ["не ноль", answer(200, '{"out":"[]"}\n{"exit":2}\n')],
      ["не массив", answer(200, '{"out":"{}"}\n{"exit":0}\n')],
      ["не JSON", answer(200, '{"out":"x"}\n{"exit":0}\n')],
      ["чужой кадр", answer(200, '{"x":1,"y":2}\n')],
      ["без кода", answer(200, '{"out":"[]"}\n')],
    ] as const
  ) {
    await t.step(name, async () => {
      assertEquals(
        await askBack("ki", {
          base: "http://127.0.0.1:1",
          token: "t",
          fetch: reply,
          deadline: () => new AbortController().signal,
        }),
        undefined,
      );
    });
  }
});
