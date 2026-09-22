/**
 * Команды на ключах (`platform/keys-translation.md`, «Граничные случаи»):
 * отказы с готовой строкой и пара разбора из сценариев спеки. До сети
 * строки не доходят: исполнение подменено строкой диспетчеризации.
 */

import { assertEquals } from "@std/assert";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { lineEntry } from "./mod.ts";
import { allowEverything, consentOf, withPolicyFile } from "./testconsent.ts";

const END = GRAMMAR.close;

async function run(file: string, argv: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const called: string[] = [];
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const code = await lineEntry(consentOf(file))(argv, makeFakeIo(), {
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  }, journal);
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

Deno.test("отказы с готовой строкой — раздел 2", async (t) => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [
      ["kiten", "comment", "55", "ok"],
      "mpu kiten comment: значение — ключом: mpu kiten comment id: 55 text: ok",
    ],
    [
      ["kiten", "comment", "id:", "55", "--message", "x"],
      "mpu kiten comment: текст — ключом: mpu kiten comment id: 55 text: x",
    ],
    [
      ["kiten", "comment", "id:", "55", "text:", "ok", "-m", "x"],
      "mpu kiten comment id: 55 text: ok: значение ok не понимает -m; " +
      "текст — ключом: mpu kiten comment id: 55 text: ok text: x",
    ],
    [
      ["xlsx", "get", "file:", "a.xlsx", "-n", "Лист1"],
      "mpu xlsx get file: a.xlsx: значение a.xlsx не понимает -n; " +
      "флаг — полным именем: mpu xlsx get file: a.xlsx --sheet Лист1",
    ],
    [
      ["kiten", "ls", "--date_from", "2026-01-01"],
      "mpu kiten ls: ключ через дефис: mpu kiten ls --date-from 2026-01-01",
    ],
    [
      ["kiten", "ls", "--md"],
      `mpu kiten ls: формат — сообщение результату: mpu kiten ls ${END} md`,
    ],
    [
      ["kiten", "status", "--out", "group"],
      "mpu kiten status: формат — сообщение результату: " +
      `mpu kiten status ${END} group`,
    ],
    [
      ["mr", "view", "--mr", "5"],
      "mpu mr view: номер — ключом: mpu mr view id: 5",
    ],
    [
      ["mr", "create", "--title", "t", "--target", "main"],
      "mpu mr create: --target — теперь ключ into: " +
      "mpu mr create title: t into: main",
    ],
    [
      ["kiten", "status", "--time-since", "30d"],
      "mpu kiten status: --time-since — теперь ключ horizon: " +
      "mpu kiten status horizon: 30d",
    ],
  ];
  await withPolicyFile(async (file) => {
    allowEverything(file);
    for (const [argv, stderr] of cases) {
      await t.step(argv.join(" "), async () => {
        assertEquals(await run(file, argv), {
          code: 2,
          stdout: "",
          stderr: `${stderr}\n`,
          called: [],
        });
      });
    }
  });
});

Deno.test("отказы с готовой строкой — раздел 3", async (t) => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [["logs", "ls"], "mpu logs: хосты — сообщением: mpu logs hosts"],
    [
      ["logs", "sl-1", "ls"],
      "mpu logs: сервисы — сообщением: mpu logs services target: sl-1",
    ],
    [
      ["ps", "--tsv"],
      `mpu ps: формат — сообщение результату: mpu ps ${END} tsv`,
    ],
    [["confirm", "-y"], "mpu confirm: флаг — полным именем: mpu confirm --yes"],
    [
      ["confirm", "-m", "да?"],
      "mpu confirm: текст — ключом: mpu confirm text: да?",
    ],
    [
      ["code", "refs", "addOne"],
      "mpu code refs: значение — ключом: mpu code refs address: addOne",
    ],
    [["search", "54"], "mpu search: значение — ключом: mpu search query: 54"],
    [
      ["move-client-back", "rm", "1234"],
      "mpu move-client-back rm: значение — ключом: " +
      "mpu move-client-back rm target: 1234",
    ],
  ];
  await withPolicyFile(async (file) => {
    allowEverything(file);
    for (const [argv, stderr] of cases) {
      await t.step(argv.join(" "), async () => {
        assertEquals(await run(file, argv), {
          code: 2,
          stdout: "",
          stderr: `${stderr}\n`,
          called: [],
        });
      });
    }
  });
});

Deno.test("отказы с готовой строкой — раздел 4", async (t) => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [
      ["process", "target:", "54", "--spreadsheet_id", "X"],
      "mpu process: ключ через дефис: " +
      "mpu process target: 54 --spreadsheet-id X",
    ],
    [
      ["ss-update", "target:", "54", "--update_type", "full"],
      "mpu ss-update: ключ через дефис: " +
      "mpu ss-update target: 54 --update-type full",
    ],
    [
      ["ozon-jobs", "sl-2", "show"],
      "mpu ozon-jobs: значение — ключом: mpu ozon-jobs show target: sl-2",
    ],
    [
      ["ozon-jobs", "show", "sl-2"],
      "mpu ozon-jobs show: значение — ключом: " +
      "mpu ozon-jobs show target: sl-2",
    ],
    [
      ["move-client", "target:", "54", "--target", "sl-2"],
      "ключ target указан дважды",
    ],
    [
      ["copy-dev", "54"],
      "mpu copy-dev: значение — ключом: mpu copy-dev target: 54",
    ],
  ];
  await withPolicyFile(async (file) => {
    allowEverything(file);
    for (const [argv, stderr] of cases) {
      await t.step(argv.join(" "), async () => {
        assertEquals(await run(file, argv), {
          code: 2,
          stdout: "",
          stderr: `${stderr}\n`,
          called: [],
        });
      });
    }
  });
});

Deno.test("отказы с готовой строкой — разделы 5 и 6", async (t) => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [
      ["api", "get-client-module", "54", "wb"],
      "mpu api get-client-module: значение — ключом: " +
      "mpu api get-client-module client: 54 id: wb",
    ],
    [
      ["api", "ss-access", "status", "abc"],
      "mpu api ss-access status: значение — ключом: " +
      "mpu api ss-access status spreadsheet: abc",
    ],
    [
      ["ssh", "sl-1", "--", "ls", "-la"],
      'mpu ssh: значение — ключом: mpu ssh target: sl-1 cmd: "ls -la"',
    ],
    [
      ["run-js", "sl-1", "1+1"],
      "mpu run-js: значение — ключом: mpu run-js target: sl-1 text: 1+1",
    ],
    [
      ["xlsx", "get", "A1", "B2"],
      "mpu xlsx get: значение — ключом: mpu xlsx get range: A1 range: B2",
    ],
  ];
  await withPolicyFile(async (file) => {
    allowEverything(file);
    for (const [argv, stderr] of cases) {
      await t.step(argv.join(" "), async () => {
        assertEquals(await run(file, argv), {
          code: 2,
          stdout: "",
          stderr: `${stderr}\n`,
          called: [],
        });
      });
    }
  });
});
