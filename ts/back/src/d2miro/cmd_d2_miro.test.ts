/**
 * Команда целиком: выбор SVG по правилам спеки, `--dry-run` против
 * голдена и коды выхода. Сети и подпроцессов здесь нет — внешний мир
 * подставляется портом `D2MiroEnv`.
 */

import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { DomainError, NotFoundIoError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { D2MiroEnv } from "./env.ts";
import { runD2MiroWith } from "./cmd_d2_miro.ts";

const dir = new URL("testdata/d2-miro/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return await readFile(new URL(name, dir), "utf8");
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

it("--dry-run: план в stdout, диагностика в stderr, ни одного вызова службы", async () => {
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
  expect(result.plan).toStrictEqual(`${planLines.join("\n")}\n`);
  expect([result.shapes, result.edges, result.markdown]).toStrictEqual([
    5,
    5,
    1,
  ]);
  // Инвариант спеки: `--dry-run` не делает ни одного вызова Miro API —
  // здесь он держится тем, что `fetch` в этом окружении бросает.
  expect(result.created).toStrictEqual(undefined);
  expect(stand.progress).toStrictEqual([
    "[warn] in d2 source but not in SVG: ['card']",
    "[info] схема.d2: 5 shapes, 5 edges, 1 markdown blocks; " +
    "viewBox 478x1146 -> frame 478x1418 (scale=1.000)",
  ]);
});

it("кириллический вход: потеря пары названа числом в строке итога", async () => {
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
  expect(stand.progress.join("\n")).toContain("; 2 without a source pair");
});

describe("выбор SVG: правила спеки по порядку", () => {
  let sample: string;
  let svg: string;

  beforeAll(async () => {
    sample = await fixture("sample.d2");
    svg = await fixture("sample.svg");
  });

  it("устаревший SVG и есть d2 — пере-рендер", async () => {
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
    expect(rendered).toStrictEqual(["s.d2 -> s.svg"]);
    expect(stand.progress[0]).toBe("[info] rendering s.d2 -> s.svg");
  });

  it("--skip-render берёт устаревший как есть", async () => {
    const stand = makeIo({ "s.d2": sample, "s.svg": svg });
    await runD2MiroWith(
      { file: "s.d2", "skip-render": true, "dry-run": true },
      stand.io,
      makeEnv({
        mtime: (path) => Promise.resolve(path.endsWith(".svg") ? 100 : 200),
        hasD2: () => Promise.reject(new Error("d2 звать не должны")),
      }),
    );
    expect(stand.progress.some((line) => line.startsWith("[info] rendering")))
      .toBe(false);
  });

  it("d2 нет, SVG устарел — предупреждение и старый файл", async () => {
    const stand = makeIo({ "s.d2": sample, "s.svg": svg });
    await runD2MiroWith(
      { file: "s.d2", "skip-render": false, "dry-run": true },
      stand.io,
      makeEnv({
        mtime: (path) => Promise.resolve(path.endsWith(".svg") ? 100 : 200),
        hasD2: () => Promise.resolve(false),
      }),
    );
    expect(stand.progress[0]).toContain("[warn] d2 CLI not found, using stale");
  });

  it("d2 нет и SVG нет — отказ с подсказкой", async () => {
    const stand = makeIo({ "s.d2": sample });
    const err = await rejected(
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
    expect(err.message).toContain("d2 CLI is not in PATH");
    expect(err.message).toContain("skip-render");
  });

  it("сбой d2 — отказ внешней системы, а не молчание", async () => {
    const stand = makeIo({ "s.d2": sample });
    await rejected(
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

describe("ошибки ввода и конфигурации — exit 2, а не сбой внешней системы", () => {
  const files = async () => ({
    "s.d2": await fixture("sample.d2"),
    "s.svg": await fixture("sample.svg"),
  });

  it("--position не парсится", async () => {
    const stand = makeIo(await files());
    await rejected(
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

  it("нет MIRO_TOKEN", async () => {
    const stand = makeIo(await files(), { MIRO_BOARD_ID: "b1" });
    await rejected(
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

  it("нет MIRO_BOARD_ID и нет --board", async () => {
    const stand = makeIo(await files(), { MIRO_TOKEN: "t" });
    await rejected(
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

describe("ни одного шейпа при непустом плане — отказ, а не зелёный код", () => {
  let files: { "s.d2": string; "s.svg": string };

  const keys = { MIRO_TOKEN: "секрет", MIRO_BOARD_ID: "доска" };

  beforeAll(async () => {
    files = {
      "s.d2": await fixture("sample.d2"),
      "s.svg": await fixture("sample.svg"),
    };
  });

  it("служба отбила каждое создание", async () => {
    // Замер живой пары 89: `[done] … shapes=0 connectors=0 skipped=10`
    // и код 0 — числа называли правду, код нет. Правило порции 93: у
    // одного факта один источник.
    const stand = makeIo(files, keys);
    const err = await rejected(
      () =>
        runD2MiroWith(
          { file: "s.d2", "skip-render": false, "dry-run": false },
          stand.io,
          makeEnv({
            fetch: (url, init) => {
              if (init.method === "GET") {
                return Promise.resolve(
                  new Response('{"data":[],"cursor":""}', { status: 200 }),
                );
              }
              // Фрейм создаётся, всё остальное отбивается — ровно то,
              // что дала живая доска на мутанте координат.
              if (url.endsWith("/frames")) {
                return Promise.resolve(
                  new Response('{"id":"frame-1"}', { status: 201 }),
                );
              }
              return Promise.resolve(
                new Response('{"message":"outside of parent boundaries"}', {
                  status: 400,
                }),
              );
            },
          }),
        ),
      DomainError,
    );
    expect(err.message).toContain(
      "не создано ни одного объекта из 5 шейпов и 1 markdown-блоков",
    );
    // Строка итога всё равно напечатана: оператору нужны числа, а не
    // только отказ.
    expect(stand.progress[stand.progress.length - 1]).toContain(
      "[done] frame='s' shapes=0 connectors=0 skipped=",
    );
  });

  it("созданный текст при нуле шейпов — не провал", async () => {
    // Обратный промах границы: шейпы отбиты «outside of parent
    // boundaries» (причина живой пары 89), а текст лёг по другим
    // координатам. Фрейм не пуст, и отказ был бы неправдой.
    const stand = makeIo(files, keys);
    const result = await runD2MiroWith(
      { file: "s.d2", "skip-render": false, "dry-run": false },
      stand.io,
      makeEnv({
        fetch: (url, init) => {
          if (init.method === "GET") {
            return Promise.resolve(
              new Response('{"data":[],"cursor":""}', { status: 200 }),
            );
          }
          if (url.endsWith("/shapes")) {
            return Promise.resolve(
              new Response('{"message":"outside of parent boundaries"}', {
                status: 400,
              }),
            );
          }
          return Promise.resolve(
            new Response('{"id":"id-1"}', {
              status: url.endsWith("/connectors") ? 200 : 201,
            }),
          );
        },
      }),
    );
    expect(result.created?.shapes).toBe(0);
    expect(result.created?.texts).toBe(1);
  });

  it("частичный успех остаётся нулевым кодом", async () => {
    // Его числа честны: сколько создано и сколько пропущено — сказано,
    // и дочитать есть что. Отказ здесь сделал бы `d2-miro` непригодной
    // на схеме, где один шейп не лёг.
    const stand = makeIo(files, keys);
    let created = 0;
    const result = await runD2MiroWith(
      { file: "s.d2", "skip-render": false, "dry-run": false },
      stand.io,
      makeEnv({
        fetch: (url, init) => {
          if (init.method === "GET") {
            return Promise.resolve(
              new Response('{"data":[],"cursor":""}', { status: 200 }),
            );
          }
          created++;
          // Второй шейп не ложится, остальное создаётся.
          if (created === 3) {
            return Promise.resolve(
              new Response('{"message":"boom"}', { status: 400 }),
            );
          }
          return Promise.resolve(
            new Response(`{"id":"id-${created}"}`, {
              status: url.endsWith("/connectors") ? 200 : 201,
            }),
          );
        },
      }),
    );
    expect(result.created?.shapes).toBe(4);
    expect((result.created?.skipped ?? 0) > 0).toBe(true);
  });
});

describe("рисовать нечего: отказ до службы, доска не тронута", () => {
  // Устаревший или чужой SVG даёт план без единого объекта. Прежде
  // такой прогон создавал на доске пустой фрейм и возвращал ноль
  // (замер спецификатора). SVG здесь синтетический — это ВХОД, а не
  // снимок чужого ответа: у d2 пустого рендера не бывает, а нужен
  // именно вырожденный случай.
  const files = {
    "п.d2": 'loader: "Загрузчик"\n',
    "п.svg": '<svg viewBox="0 0 100 50"></svg>',
  };
  const keys = { MIRO_TOKEN: "секрет", MIRO_BOARD_ID: "доска" };

  it("рендер: ни одного обращения к службе", async () => {
    const stand = makeIo(files, keys);
    let calls = 0;
    const err = await rejected(
      () =>
        runD2MiroWith(
          { file: "п.d2", "skip-render": true, "dry-run": false },
          stand.io,
          makeEnv({
            fetch: () => {
              calls++;
              return Promise.resolve(new Response("{}", { status: 200 }));
            },
          }),
        ),
      UsageError,
      "в плане нет ни одного объекта",
    );
    // Не «фрейм не создан», а именно ноль обращений: иначе проверка не
    // отличит «не создали» от «создали и удалили».
    expect(calls, "служба вызывалась при пустом плане").toBe(0);
    expect(err.message).toContain("п.svg");
  });

  it("один markdown-блок — уже есть что рисовать", async () => {
    // Граница считает шейпы И блоки: у входа из одних `|md` шейпов нет
    // по построению, и счёт по одним шейпам отказал бы там, где рисовать
    // есть что. Мутация «убрать markdown из условия» краснеет здесь.
    const stand = makeIo({
      "м.d2": "card: |md\n  ## Карточка\n|\n",
      "м.svg": '<svg viewBox="0 0 100 50"></svg>',
    }, keys);
    const result = await runD2MiroWith(
      { file: "м.d2", "skip-render": true, "dry-run": true },
      stand.io,
      makeEnv(),
    );
    expect([result.shapes, result.markdown]).toStrictEqual([0, 1]);
    expect(stand.progress.join("\n")).toContain(
      "0 shapes, 0 edges, 1 markdown blocks",
    );
  });

  it("--dry-run отказывает тем же", async () => {
    // План обязан совпадать с рендером (отклонение-fix спеки): показ
    // пустого списка вместо отказа делал бы предпросмотр враньём.
    const stand = makeIo(files, keys);
    await rejected(
      () =>
        runD2MiroWith(
          { file: "п.d2", "skip-render": true, "dry-run": true },
          stand.io,
          makeEnv(),
        ),
      UsageError,
      "в плане нет ни одного объекта",
    );
    // Строки разбора всё равно напечатаны: по ним видно, почему пусто.
    expect(stand.progress.join("\n")).toContain(
      "0 shapes, 0 edges, 0 markdown blocks",
    );
  });
});

it("вход, которого нет: ошибка ввода, а не сбой рантайма", async () => {
  const stand = makeIo({});
  await rejected(
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

describe("--position: недописанная пара — отказ, а не ноль по умолчанию", () => {
  let files: { "s.d2": string; "s.svg": string };

  beforeAll(async () => {
    files = {
      "s.d2": await fixture("sample.d2"),
      "s.svg": await fixture("sample.svg"),
    };
  });

  for (const raw of ["abc", "1,", ",", "1", "1,2,3", " , "]) {
    it(raw, async () => {
      const stand = makeIo(files);
      await rejected(
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

it("отказ службы — доменная ошибка с текстом, а не unexpected", async () => {
  const stand = makeIo({
    "s.d2": await fixture("sample.d2"),
    "s.svg": await fixture("sample.svg"),
  }, { MIRO_TOKEN: "секрет", MIRO_BOARD_ID: "доска" });
  const err = await rejected(
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
  expect(err.message).toContain("miro GET /items?type=frame");
  expect(err.message).toContain("-> 401");
  expect(err.message.includes("секрет"), "токен в тексте отказа").toBe(false);
});

it("рендер: итог называет числа, снятые с ответов службы", async () => {
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
  expect(sent[0].url).toContain("/boards/%D0%B4%D0%BE%D1%81%D0%BA%D0%B0/");
  expect(sent.some((call) => call.url.includes("секрет"))).toBe(false);
  // Каждый шейп и текст создаются ребёнком фрейма: без `parent` они
  // легли бы на холст мимо фрейма, и повторный рендер их не убрал бы.
  const children = sent.filter((call) =>
    call.url.endsWith("/shapes") || call.url.endsWith("/texts")
  );
  expect(children.length).toBe(6);
  for (const call of children) {
    expect((call.body as { parent: unknown }).parent).toStrictEqual({
      id: "id-1",
    });
  }
  // Двунаправленная пара разводится привязками: у ребра с алфавитно
  // меньшим src — `top`, у обратного — `bottom` (спека).
  const connectors = sent
    .filter((call) => call.url.endsWith("/connectors"))
    .map((call) =>
      (call.body as { startItem: { snapTo?: string } }).startItem.snapTo
    );
  expect(connectors.filter((snap) => snap === "top").length).toBe(1);
  expect(connectors.filter((snap) => snap === "bottom").length).toBe(1);
  expect(result.created).toStrictEqual({
    shapes: 5,
    texts: 1,
    connectors: 4,
    skipped: 1,
    retries: 0,
  });
  expect(result.frameId).toBe("id-1");
  const done = stand.progress[stand.progress.length - 1];
  // `texts` печатается наравне с прочими: это число участвует в решении
  // об отказе, и без него по выводу не понять, почему код именно такой
  // (`d2-miro.md`, формат итоговой строки).
  expect(done).toBe("[done] frame='s' shapes=5 texts=1 connectors=4 skipped=1");
});
