/**
 * Команда целиком: выбор SVG по правилам спеки, `--dry-run` против
 * голдена и коды выхода. Сети и подпроцессов здесь нет — внешний мир
 * подставляется портом `D2MiroEnv`.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DomainError, NotFoundIoError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { D2MiroEnv } from "./env.ts";
import { runD2MiroWith } from "./cmd_d2_miro.ts";

const dir = new URL("testdata/d2-miro/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, dir));
}

/** Внешний мир по умолчанию: SVG свежий, `d2` есть, сеть запрещена. */
function makeEnv(overrides: Partial<D2MiroEnv> = {}): D2MiroEnv {
  return {
    mtime: (path) => Promise.resolve(path.endsWith(".svg") ? 200 : 100),
    hasD2: () => Promise.resolve(true),
    renderSvg: () => {
      throw new Error("renderSvg не ожидается");
    },
    fetch: () => {
      throw new Error("сеть не ожидается");
    },
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

/** Порт команды: файлы фикстур и собранная диагностика. */
function makeIo(
  files: Record<string, string>,
  keys: Record<string, string> = {},
) {
  const progress: string[] = [];
  const encoder = new TextEncoder();
  const io = makeFakeIo({
    // Команда читает вход через `readRegularFile`: у него каталог и
    // отсутствие — один ответ, и это ошибка ввода, а не сбой рантайма.
    readRegularFile: (path) => {
      const text = files[path];
      if (text === undefined) {
        return Promise.reject(new NotFoundIoError(`нет файла ${path}`));
      }
      return Promise.resolve(encoder.encode(text));
    },
    envFile: {
      get: (name) => keys[name],
      values: () => ({ ...keys }),
      // Текст платформенный — команда только меняет класс ошибки, и в
      // фейке он повторён дословно (`src/env/mod.ts`, «Ввод/вывод»):
      // иначе проверка кода выхода прошла бы на своём же тексте.
      require: (name) => {
        const value = keys[name];
        if (value !== undefined && value !== "") return value;
        throw new Error(
          `environment variable ${name} is not set. ` +
            `Add it to ~/.config/mpu/.env or export in shell.`,
        );
      },
      set: () => Promise.reject(new Error("set не ожидается")),
    },
    progress: (line) => void progress.push(line),
  });
  return { io, progress };
}

Deno.test("--dry-run: план в stdout, диагностика в stderr, ни одного вызова службы", async () => {
  const files = {
    "схема.d2": await fixture("sample.d2"),
    "схема.svg": await fixture("sample.svg"),
  };
  const stand = makeIo(files);
  const result = await runD2MiroWith(
    { file: "схема.d2", "skip-render": false, "dry-run": true },
    stand.io,
    makeEnv(),
  );
  // План — тот же текст, что у объекта (голден плана снят с него).
  const golden = await fixture("sample-dry-run.txt");
  const planLines = golden.split("\n").filter((line) =>
    line.startsWith("[dry-run]") || line.startsWith("  ")
  );
  assertEquals(result.plan, `${planLines.join("\n")}\n`);
  assertEquals([result.shapes, result.edges, result.markdown], [5, 5, 1]);
  // Инвариант спеки: `--dry-run` не делает ни одного вызова Miro API —
  // здесь он держится тем, что `fetch` в этом окружении бросает.
  assertEquals(result.created, undefined);
  assertEquals(stand.progress, [
    "[warn] in d2 source but not in SVG: ['card']",
    "[info] схема.d2: 5 shapes, 5 edges, 1 markdown blocks; " +
    "viewBox 478x1146 -> frame 478x1418 (scale=1.000)",
  ]);
});

Deno.test("кириллический вход: потеря пары названа числом в строке итога", async () => {
  const files = {
    "к.d2": await fixture("sample-cyrillic.d2"),
    "к.svg": await fixture("sample-cyrillic.svg"),
  };
  const stand = makeIo(files);
  await runD2MiroWith(
    { file: "к.d2", "skip-render": false, "dry-run": true },
    stand.io,
    makeEnv(),
  );
  assertStringIncludes(
    stand.progress.join("\n"),
    "; 2 without a source pair",
  );
});

Deno.test("выбор SVG: правила спеки по порядку", async (t) => {
  const sample = await fixture("sample.d2");
  const svg = await fixture("sample.svg");

  await t.step("устаревший SVG и есть d2 — пере-рендер", async () => {
    const rendered: string[] = [];
    const stand = makeIo({ "s.d2": sample, "s.svg": svg });
    await runD2MiroWith(
      { file: "s.d2", "skip-render": false, "dry-run": true },
      stand.io,
      makeEnv({
        mtime: (path) => Promise.resolve(path.endsWith(".svg") ? 100 : 200),
        renderSvg: (input, output) => {
          rendered.push(`${input} -> ${output}`);
          return Promise.resolve({ code: 0, stderr: "" });
        },
      }),
    );
    assertEquals(rendered, ["s.d2 -> s.svg"]);
    assertEquals(stand.progress[0], "[info] rendering s.d2 -> s.svg");
  });

  await t.step("--skip-render берёт устаревший как есть", async () => {
    const stand = makeIo({ "s.d2": sample, "s.svg": svg });
    await runD2MiroWith(
      { file: "s.d2", "skip-render": true, "dry-run": true },
      stand.io,
      makeEnv({
        mtime: (path) => Promise.resolve(path.endsWith(".svg") ? 100 : 200),
        hasD2: () => Promise.reject(new Error("d2 звать не должны")),
      }),
    );
    assertEquals(
      stand.progress.some((line) => line.startsWith("[info] rendering")),
      false,
    );
  });

  await t.step(
    "d2 нет, SVG устарел — предупреждение и старый файл",
    async () => {
      const stand = makeIo({ "s.d2": sample, "s.svg": svg });
      await runD2MiroWith(
        { file: "s.d2", "skip-render": false, "dry-run": true },
        stand.io,
        makeEnv({
          mtime: (path) => Promise.resolve(path.endsWith(".svg") ? 100 : 200),
          hasD2: () => Promise.resolve(false),
        }),
      );
      assertStringIncludes(
        stand.progress[0],
        "[warn] d2 CLI not found, using stale",
      );
    },
  );

  await t.step("d2 нет и SVG нет — отказ с подсказкой", async () => {
    const stand = makeIo({ "s.d2": sample });
    const err = await assertRejects(
      () =>
        runD2MiroWith(
          { file: "s.d2", "skip-render": false, "dry-run": true },
          stand.io,
          makeEnv({
            mtime: (path) =>
              Promise.resolve(path.endsWith(".svg") ? undefined : 100),
            hasD2: () => Promise.resolve(false),
          }),
        ),
      DomainError,
    );
    assertStringIncludes(err.message, "d2 CLI is not in PATH");
    assertStringIncludes(err.message, "--skip-render");
  });

  await t.step("сбой d2 — отказ внешней системы, а не молчание", async () => {
    const stand = makeIo({ "s.d2": sample });
    await assertRejects(
      () =>
        runD2MiroWith(
          { file: "s.d2", "skip-render": false, "dry-run": true },
          stand.io,
          makeEnv({
            mtime: () => Promise.resolve(undefined),
            renderSvg: () =>
              Promise.resolve({ code: 1, stderr: "d2: parse error" }),
          }),
        ),
      DomainError,
      "d2 render failed (1)",
    );
  });
});

Deno.test("ошибки ввода и конфигурации — exit 2, а не сбой внешней системы", async (t) => {
  const files = async () => ({
    "s.d2": await fixture("sample.d2"),
    "s.svg": await fixture("sample.svg"),
  });

  await t.step("--position не парсится", async () => {
    const stand = makeIo(await files());
    await assertRejects(
      () =>
        runD2MiroWith(
          {
            file: "s.d2",
            position: "abc",
            "skip-render": false,
            "dry-run": true,
          },
          stand.io,
          makeEnv(),
        ),
      UsageError,
      "--position",
    );
  });

  await t.step("нет MIRO_TOKEN", async () => {
    const stand = makeIo(await files(), { MIRO_BOARD_ID: "b1" });
    await assertRejects(
      () =>
        runD2MiroWith(
          { file: "s.d2", "skip-render": false, "dry-run": false },
          stand.io,
          makeEnv(),
        ),
      UsageError,
      "MIRO_TOKEN",
    );
  });

  await t.step("нет MIRO_BOARD_ID и нет --board", async () => {
    const stand = makeIo(await files(), { MIRO_TOKEN: "t" });
    await assertRejects(
      () =>
        runD2MiroWith(
          { file: "s.d2", "skip-render": false, "dry-run": false },
          stand.io,
          makeEnv(),
        ),
      UsageError,
      "MIRO_BOARD_ID",
    );
  });
});

Deno.test("вход, которого нет: ошибка ввода, а не сбой рантайма", async () => {
  const stand = makeIo({});
  await assertRejects(
    () =>
      runD2MiroWith(
        { file: "нет.d2", "skip-render": false, "dry-run": true },
        stand.io,
        makeEnv(),
      ),
    UsageError,
    "нет.d2",
  );
});

Deno.test("--position: недописанная пара — отказ, а не ноль по умолчанию", async (t) => {
  const files = {
    "s.d2": await fixture("sample.d2"),
    "s.svg": await fixture("sample.svg"),
  };
  // У пустой строки значение 0, поэтому «1,» без проверки прошло бы
  // молча и поставило фрейм на y=0 — на живой доске мимо места.
  for (const raw of ["abc", "1,", ",", "1", "1,2,3", " , "]) {
    await t.step(raw, async () => {
      const stand = makeIo(files);
      await assertRejects(
        () =>
          runD2MiroWith(
            {
              file: "s.d2",
              position: raw,
              "skip-render": false,
              "dry-run": true,
            },
            stand.io,
            makeEnv(),
          ),
        UsageError,
        "--position",
      );
    });
  }
});

Deno.test("отказ службы — доменная ошибка с текстом, а не unexpected", async () => {
  const stand = makeIo({
    "s.d2": await fixture("sample.d2"),
    "s.svg": await fixture("sample.svg"),
  }, { MIRO_TOKEN: "секрет", MIRO_BOARD_ID: "доска" });
  const err = await assertRejects(
    () =>
      runD2MiroWith(
        { file: "s.d2", "skip-render": false, "dry-run": false },
        stand.io,
        makeEnv({
          fetch: () =>
            Promise.resolve(
              new Response('{"code":"tokenNotProvided"}', { status: 401 }),
            ),
        }),
      ),
    DomainError,
  );
  // Точка входа печатает доменную ошибку как `mpu d2-miro: <причина>`
  // и даёт код 1; сырой класс клиента уходил бы «unexpected error» с
  // кодом внешних систем и трейсом (отклонение-fix спеки).
  assertStringIncludes(err.message, "miro GET /items?type=frame");
  assertStringIncludes(err.message, "-> 401");
  assertEquals(err.message.includes("секрет"), false, "токен в тексте отказа");
});

Deno.test("рендер: итог называет числа, снятые с ответов службы", async () => {
  const stand = makeIo({
    "s.d2": await fixture("sample.d2"),
    "s.svg": await fixture("sample.svg"),
  }, { MIRO_TOKEN: "секрет", MIRO_BOARD_ID: "доска" });
  let created = 0;
  const sent: { url: string; body: unknown }[] = [];
  const result = await runD2MiroWith(
    { file: "s.d2", "skip-render": false, "dry-run": false },
    stand.io,
    makeEnv({
      fetch: (url, init) => {
        sent.push({
          url,
          body: init.body === undefined ? undefined : JSON.parse(init.body),
        });
        if (init.method === "GET") {
          return Promise.resolve(
            new Response('{"data":[],"cursor":""}', { status: 200 }),
          );
        }
        created++;
        return Promise.resolve(
          new Response(`{"id":"id-${created}"}`, {
            status: url.endsWith("/connectors") ? 200 : 201,
          }),
        );
      },
    }),
  );
  // Доска адресуется id доски, а не токеном: перепутанные местами
  // аргументы клиента отправили бы секрет в URL.
  assertStringIncludes(sent[0].url, "/boards/%D0%B4%D0%BE%D1%81%D0%BA%D0%B0/");
  assertEquals(sent.some((call) => call.url.includes("секрет")), false);
  // Каждый шейп и текст создаются ребёнком фрейма: без `parent` они
  // легли бы на холст мимо фрейма, и повторный рендер их не убрал бы.
  const children = sent.filter((call) =>
    call.url.endsWith("/shapes") || call.url.endsWith("/texts")
  );
  assertEquals(children.length, 6);
  for (const call of children) {
    assertEquals((call.body as { parent: unknown }).parent, { id: "id-1" });
  }
  // Двунаправленная пара разводится привязками: у ребра с алфавитно
  // меньшим src — `top`, у обратного — `bottom` (спека).
  const connectors = sent
    .filter((call) => call.url.endsWith("/connectors"))
    .map((call) =>
      (call.body as { startItem: { snapTo?: string } }).startItem.snapTo
    );
  assertEquals(connectors.filter((snap) => snap === "top").length, 1);
  assertEquals(connectors.filter((snap) => snap === "bottom").length, 1);
  assertEquals(result.created, {
    shapes: 5,
    texts: 1,
    connectors: 4,
    skipped: 1,
    retries: 0,
  });
  assertEquals(result.frameId, "id-1");
  const done = stand.progress[stand.progress.length - 1];
  assertEquals(done, "[done] frame='s' shapes=5 connectors=4 skipped=1");
});
