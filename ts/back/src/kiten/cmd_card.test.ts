/**
 * Команда `mpu kiten card` (`docs/specs/kiten-card.md`). Три вида вывода
 * закрыты голденами канала: живой комплект снят на тестовой карточке
 * Kaiten, синтетический собран ради ветвей, которых на живой карточке нет
 * (непустой `key`, непустые `members`, свойство вне справочника имён).
 *
 * Вход тестов — ответы внешней границы из тех же голденов, а не
 * подставленный порт: команда ходит в каталог, каталог — в фейковый Kaiten
 * на петле (`@mpu/kaiten/testing`). Так проверяется и то, каких запросов
 * команда НЕ делает: справочника имён на `--json`, комментариев на
 * `--no-comments`.
 *
 * Вызов идёт от argv, как из точки входа: разбор делает схема самой
 * команды, поэтому под проверку попадают и формы записи флагов, включая
 * отрицательные `--no-*`.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import {
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "@mpu/kaiten/testing";
import {
  type KitenCardArgs,
  kitenCardCommand,
  type KitenCardResult,
  runKitenCard,
} from "./mod.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";
const CARD_ID = 10000001;
const SELECTOR = String(CARD_ID);

/** Пути каталога, которые команда вправе трогать. */
const CARD_PATH = `/api/latest/cards/${CARD_ID}`;
const COMMENTS_PATH = `${CARD_PATH}/comments`;
const PROPERTIES_PATH = "/api/latest/company/custom-properties";

/**
 * Справочник имён при съёме живого комплекта: сами имена видны в
 * `live-md-stdout.md`, а ответ вызова в голденах канала не лежит.
 */
const LIVE_PROPERTIES = [
  { id: 291984, name: "6. Причина/гипотеза", type: "string" },
  { id: 291985, name: "7. Что сделано", type: "string" },
  { id: 291990, name: "8. Результат", type: "string" },
  { id: 398965, name: "Ссылка на Merge Request", type: "string" },
];

/** Справочник при съёме синтетического комплекта — назван спекой. */
const SYNTHETIC_PROPERTIES = [
  { id: 398965, name: "Ссылка на Merge Request", type: "string" },
  { id: 291984, name: "6. Причина/гипотеза", type: "string" },
];

/**
 * Пустая карточка сразу после создания: голдены канала несут её выводы, а
 * ответ сервера — нет, поэтому вход собран по ним. Проверяет он не разбор,
 * а рендер: какие строки шапки пропадают без значения и что остаётся.
 */
const EMPTY_CARD = {
  id: CARD_ID,
  key: null,
  title: "тест",
  state: 2,
  condition: 1,
  due_date: null,
  size_text: null,
  created: "2026-08-14T16:32:53.473Z",
  updated: "2026-08-14T16:32:53.473Z",
  description: null,
  board: { id: 501, title: "Разработка" },
  column: { id: 6001, title: "Бэклог" },
  lane: { title: "Основная" },
  owner: {
    id: 700001,
    full_name: "Иванов Иван",
    email: "owner@example.test",
    username: "ivanov",
  },
  tags: [],
  members: [],
  files: [],
  properties: {},
  checklists: [],
};

function golden(name: string): Promise<string> {
  return readFile(
    new URL(`testdata/kiten-card/${name}`, import.meta.url),
    "utf8",
  );
}

/** Адрес карточки в голденах: снят с обезличенного живого прогона. */
const GOLDEN_CARD_URL = `https://kaiten.example.test/${CARD_ID}`;

/**
 * Голден вывода с адресом карточки под стенд. Web-адрес строится от того
 * же базового URL, что и вызовы API (`platform/kaiten-http.md`), а у стенда
 * это порт на петле — подставляется ровно адрес карточки, поэтому ссылки на
 * файлы внутри голдена остаются нетронутыми.
 */
async function expected(name: string, baseUrl: string): Promise<string> {
  return (await golden(name)).replaceAll(
    GOLDEN_CARD_URL,
    `${baseUrl}/${CARD_ID}`,
  );
}

/** Голден-вход отдаётся сервером дословно: разбирает его сам каталог. */
async function body(name: string): Promise<Response> {
  return new Response(await golden(name), {
    headers: { "content-type": "application/json" },
  });
}

/** Чем отвечать на путь; путь вне таблицы — красный тест, а не пустой ответ. */
type Routes = Readonly<Record<string, () => Response | Promise<Response>>>;

interface Stand {
  readonly io: CommandIo;
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly stop: () => Promise<void>;
}

async function stand(routes: Routes, terminal = false): Promise<Stand> {
  const fake = await startFakeKaiten((seen) => {
    const route = routes[seen[seen.length - 1].pathname];
    return route === undefined
      ? new Response("путь, которого тест не ждал", { status: 500 })
      : route();
  });
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: API_KEY,
    KITEN_BASE_URL: fake.baseUrl,
  };
  const io = makeFakeIo({
    stdoutIsTerminal: () => terminal,
    envFile: {
      get: (name) => values[name],
      values: () => values,
      require: (name) => values[name] ?? "",
      set: () => Promise.resolve(),
    },
  });
  return { io, baseUrl: fake.baseUrl, seen: fake.seen, stop: fake.stop };
}

/** Исполнение по argv: разбор — той же схемой, что у точки входа. */
function run(argv: readonly string[], io: CommandIo): Promise<KitenCardResult> {
  // Приведение сужает объект, уже проверенный схемой команды: типы стёрты
  // ради общего реестра, форма у них та же.
  const args = kitenCardCommand.parseArgs(argv) as KitenCardArgs;
  return runKitenCard(args, io);
}

/** Текст вывода так, как его напечатает точка входа. */
async function output(argv: readonly string[], io: CommandIo): Promise<string> {
  return kitenCardCommand.renderResult(await run(argv, io), argv);
}

/** Пути запросов в порядке обращения: наблюдаемый состав вызовов. */
function paths(seen: readonly CapturedRequest[]): readonly string[] {
  return seen.map((request) => request.pathname);
}

describe("живая карточка: три вида вывода сходятся с голденами", () => {
  const live: Routes = {
    [CARD_PATH]: () => body("live-raw-card.json"),
    [COMMENTS_PATH]: () => body("live-raw-comments.json"),
    [PROPERTIES_PATH]: () => Response.json(LIVE_PROPERTIES),
  };

  it("--json: сырой JSON, справочник не запрашивается", async () => {
    const { io, baseUrl, seen, stop } = await stand(live);
    try {
      expect(await output([SELECTOR, "--json"], io)).toStrictEqual(
        await expected("live-json-stdout.json", baseUrl),
      );
      // Имена полей JSON-выводу не нужны — и запроса за ними нет
      // (`kiten-card.md`, «Известные отклонения»).
      expect(paths(seen)).toStrictEqual([CARD_PATH, COMMENTS_PATH]);
    } finally {
      await stop();
    }
  });

  it("--json не зависит от --images", async () => {
    const { io, baseUrl, stop } = await stand(live);
    try {
      expect(
        await output([SELECTOR, "--json", "--no-images"], io),
      ).toStrictEqual(await expected("live-json-stdout.json", baseUrl));
    } finally {
      await stop();
    }
  });

  it("--md: комментарии отсортированы по created", async () => {
    const { io, baseUrl, seen, stop } = await stand(live);
    try {
      // Вход неупорядочен — седьмой по времени комментарий приходит
      // шестым; вывод по возрастанию `created`. Пара «этот вход → этот
      // голден» и проверяет сортировку.
      expect(await output([SELECTOR, "--md"], io)).toStrictEqual(
        await expected("live-md-stdout.md", baseUrl),
      );
      expect(paths(seen).length).toBe(3);
    } finally {
      await stop();
    }
  });

  it("--no-comments: раздела нет и запроса нет", async () => {
    const { io, baseUrl, seen, stop } = await stand(live);
    try {
      const argv = [SELECTOR, "--md", "--no-comments"];
      const result = await run(argv, io);

      expect(kitenCardCommand.renderResult(result, argv)).toStrictEqual(
        await expected("live-md-no-comments-stdout.md", baseUrl),
      );
      expect(result.card.comments).toStrictEqual([]);
      expect(paths(seen)).toStrictEqual([CARD_PATH, PROPERTIES_PATH]);
    } finally {
      await stop();
    }
  });
});

describe("синтетическая карточка: key, участники, поле вне справочника", () => {
  const synthetic: Routes = {
    [CARD_PATH]: () => body("synthetic-card-detail.json"),
    [COMMENTS_PATH]: () => body("synthetic-comments.json"),
    [PROPERTIES_PATH]: () => Response.json(SYNTHETIC_PROPERTIES),
  };

  it("--json", async () => {
    const { io, baseUrl, stop } = await stand(synthetic);
    try {
      expect(await output([SELECTOR, "--json"], io)).toStrictEqual(
        await expected("synthetic-json-stdout.json", baseUrl),
      );
    } finally {
      await stop();
    }
  });

  it("--md: неизвестное поле печатается сырым ключом", async () => {
    const { io, baseUrl, stop } = await stand(synthetic);
    try {
      expect(await output([SELECTOR, "--md"], io)).toStrictEqual(
        await expected("synthetic-md-stdout.md", baseUrl),
      );
    } finally {
      await stop();
    }
  });

  it("--md --no-comments", async () => {
    const { io, baseUrl, stop } = await stand(synthetic);
    try {
      expect(
        await output([SELECTOR, "--md", "--no-comments"], io),
      ).toStrictEqual(
        await expected("synthetic-md-no-comments-stdout.md", baseUrl),
      );
    } finally {
      await stop();
    }
  });
});

describe("пустая карточка: строки шапки без значения не печатаются", () => {
  const empty: Routes = {
    [CARD_PATH]: () => Response.json(EMPTY_CARD),
    [COMMENTS_PATH]: () => Response.json([]),
    [PROPERTIES_PATH]: () => Response.json([]),
  };

  it("--json: properties {}, comments [], ключи на месте", async () => {
    const { io, baseUrl, stop } = await stand(empty);
    try {
      expect(await output([SELECTOR, "--json"], io)).toStrictEqual(
        await expected("live-empty-json-stdout.json", baseUrl),
      );
    } finally {
      await stop();
    }
  });

  it("--md: «нет описания», URL и Этап остаются", async () => {
    const { io, baseUrl, stop } = await stand(empty);
    try {
      expect(await output([SELECTOR, "--md"], io)).toStrictEqual(
        await expected("live-empty-md-stdout.md", baseUrl),
      );
    } finally {
      await stop();
    }
  });
});

describe("файловое поле: массив в JSON, элементы через запятую в markdown", () => {
  const withFile: Routes = {
    [CARD_PATH]: () => body("raw-card-file-property.json"),
    [COMMENTS_PATH]: () => Response.json([]),
    [PROPERTIES_PATH]: () =>
      Response.json([
        ...LIVE_PROPERTIES,
        {
          id: 610303,
          name: "9. AI-артефакт",
          type: "file",
        },
      ]),
  };

  it("JSON: массив остаётся массивом", async () => {
    const { io, stop } = await stand(withFile);
    try {
      const result = await run([SELECTOR, "--json"], io);

      expect(result.card.properties.id_610303).toStrictEqual([
        "99536012-bcad-4801-bfe7-30c958fcbf22",
      ]);
    } finally {
      await stop();
    }
  });

  it("markdown: два элемента — через `, `", async () => {
    // У живого входа в поле один uid, и разделитель на нём недоказуем:
    // склейка пустой строкой дала бы тот же текст.
    const { io, stop } = await stand({
      [CARD_PATH]: () =>
        Response.json({
          ...EMPTY_CARD,
          properties: { id_610303: ["uid-1", "uid-2"] },
        }),
      [COMMENTS_PATH]: () => Response.json([]),
      [PROPERTIES_PATH]: () =>
        Response.json([{ id: 610303, name: "9. AI-артефакт", type: "file" }]),
    });
    try {
      const text = await output([SELECTOR, "--md"], io);

      expect(text.includes("- 9. AI-артефакт: uid-1, uid-2")).toBe(true);
    } finally {
      await stop();
    }
  });

  it("markdown: элементы через `, `, без скобок и кавычек", async () => {
    const { io, stop } = await stand(withFile);
    try {
      const text = await output([SELECTOR, "--md"], io);

      expect(
        text.includes("- 9. AI-артефакт: 99536012-bcad-4801-bfe7-30c958fcbf22"),
        "значение-массив печатается элементами, а не представлением списка",
      ).toBe(true);
    } finally {
      await stop();
    }
  });
});

it("справочник имён не ответил: сырые ключи, команда не падает", async () => {
  const { io, stop } = await stand({
    [CARD_PATH]: () => body("live-raw-card.json"),
    [COMMENTS_PATH]: () => Response.json([]),
    [PROPERTIES_PATH]: () => new Response("boom", { status: 500 }),
  });
  try {
    const text = await output([SELECTOR, "--md"], io);

    expect(text.includes("- id_291984: "), "печатается сырой ключ").toBe(true);
    expect(text.includes("6. Причина/гипотеза")).toBe(false);
  } finally {
    await stop();
  }
});

describe("выбор вида: терминал — наглядный, пайп — markdown", () => {
  const routes: Routes = {
    [CARD_PATH]: () => Response.json(EMPTY_CARD),
    [COMMENTS_PATH]: () => Response.json([]),
    [PROPERTIES_PATH]: () => Response.json([]),
  };

  it("stdout не терминал — markdown", async () => {
    const { io, stop } = await stand(routes);
    try {
      expect((await run([SELECTOR], io)).view).toBe("md");
    } finally {
      await stop();
    }
  });

  it("stdout терминал — наглядный вид", async () => {
    const { io, stop } = await stand(routes, true);
    try {
      const result = await run([SELECTOR], io);
      const text = kitenCardCommand.renderResult(result, [SELECTOR]);

      expect(result.view).toBe("pretty");
      // Оформление — свобода реализации, но markdown-разметки в нём нет.
      expect(text.includes("\x1b[1mтест\x1b[0m")).toBe(true);
      expect(text.includes("# тест")).toBe(false);
    } finally {
      await stop();
    }
  });

  it("--md побеждает терминальность stdout", async () => {
    const { io, stop } = await stand(routes, true);
    try {
      expect((await run([SELECTOR, "--md"], io)).view).toBe("md");
    } finally {
      await stop();
    }
  });

  it("--json побеждает --md", async () => {
    const { io, stop } = await stand(routes, true);
    try {
      expect((await run([SELECTOR, "--md", "--json"], io)).view).toBe("json");
    } finally {
      await stop();
    }
  });
});

it("--no-images: картинки-вложения уходят из наглядного вида", async () => {
  const { io, stop } = await stand(
    {
      [CARD_PATH]: () =>
        Response.json({
          ...EMPTY_CARD,
          files: [
            {
              id: 1,
              url: "https://files.example.test/a.png",
              name: "схема.png",
            },
            { id: 2, url: "https://files.example.test/b.txt", name: "лог.txt" },
          ],
        }),
      [COMMENTS_PATH]: () => Response.json([]),
      [PROPERTIES_PATH]: () => Response.json([]),
    },
    true,
  );
  try {
    const shown = await output([SELECTOR], io);
    const hidden = await output([SELECTOR, "--no-images"], io);

    expect(shown.includes("схема.png")).toBe(true);
    expect(hidden.includes("схема.png")).toBe(false);
    // Прочие вложения флаг не трогает.
    expect(hidden.includes("лог.txt")).toBe(true);
  } finally {
    await stop();
  }
});

it("недоступная карточка: 403 с пустым телом, exit 1", async () => {
  const { io, seen, stop } = await stand({
    "/api/latest/cards/99999999": () => new Response(null, { status: 403 }),
  });
  try {
    const err = await rejected(() => run(["99999999"], io), DomainError);

    expect(
      `${formatCommandError(kitenCardCommand.errorName, err)}\n`,
    ).toStrictEqual(await golden("err-not-found-stderr.txt"));
    // Комментарии и справочник не запрашиваются: карточки нет.
    expect(paths(seen)).toStrictEqual(["/api/latest/cards/99999999"]);
  } finally {
    await stop();
  }
});

it("невалидный селектор: exit 2, без единого запроса", async () => {
  const { io, seen, stop } = await stand({});
  try {
    const err = await rejected(() => run(["abc"], io), UsageError);

    expect(`${err.message}\n`).toStrictEqual(
      await golden("err-selector-message.txt"),
    );
    expect(seen).toStrictEqual([]);
  } finally {
    await stop();
  }
});

describe("метка этапа: закрытый список и число вне его", () => {
  const cases: readonly (readonly [number, string])[] = [
    [1, "queued"],
    [2, "in progress"],
    [3, "done"],
    [7, "7"],
  ];
  for (const [state, label] of cases) {
    it(`${state} → ${label}`, async () => {
      const { io, stop } = await stand({
        [CARD_PATH]: () => Response.json({ ...EMPTY_CARD, state }),
        [COMMENTS_PATH]: () => Response.json([]),
        [PROPERTIES_PATH]: () => Response.json([]),
      });
      try {
        expect((await run([SELECTOR, "--json"], io)).card.state).toStrictEqual(
          label,
        );
      } finally {
        await stop();
      }
    });
  }
});

it("наглядный вид: свойства и комментарии без markdown-разметки", async () => {
  const { io, stop } = await stand(
    {
      [CARD_PATH]: () =>
        Response.json({
          ...EMPTY_CARD,
          properties: { id_291984: "гипотеза", id_610303: ["uid-1", "uid-2"] },
        }),
      [COMMENTS_PATH]: () =>
        Response.json([
          {
            id: 5001,
            text: "первый",
            created: "2026-08-14T16:33:42.672Z",
            author: {
              id: 700001,
              full_name: "Иванов Иван",
              username: "ivanov",
            },
          },
        ]),
      [PROPERTIES_PATH]: () => Response.json(LIVE_PROPERTIES),
    },
    true,
  );
  try {
    const text = await output([SELECTOR], io);

    expect(text.includes("\x1b[1mСвойства\x1b[0m")).toBe(true);
    expect(text.includes("6. Причина/гипотеза: гипотеза")).toBe(true);
    // Значение-массив и в наглядном виде печатается элементами.
    expect(text.includes("id_610303: uid-1, uid-2")).toBe(true);
    expect(text.includes("\x1b[1mКомментарии\x1b[0m")).toBe(true);
    expect(text.includes("\x1b[1mИванов Иван · 2026-08-14 16:33\x1b[0m")).toBe(
      true,
    );
    expect(text.includes("## ")).toBe(false);
  } finally {
    await stop();
  }
});

it("границы markdown: нет автора, нет момента, файл без имени", async () => {
  const { io, stop } = await stand({
    [CARD_PATH]: () =>
      Response.json({
        ...EMPTY_CARD,
        files: [{ id: 9, url: "https://files.example.test/c.bin", name: "" }],
      }),
    [COMMENTS_PATH]: () =>
      Response.json([
        { id: 1, text: "без автора и момента" },
        {
          id: 2,
          text: "без момента",
          author: { id: 7, full_name: "Петрова Мария", username: "petrova" },
        },
      ]),
    [PROPERTIES_PATH]: () => Response.json([]),
  });
  try {
    const text = await output([SELECTOR, "--md"], io);

    // Автора нет — прочерк; момента нет — в заголовке только автор.
    expect(text.includes("### —\n")).toBe(true);
    expect(text.includes("### Петрова Мария\n")).toBe(true);
    const headings = text.split("\n").filter((line) => line.startsWith("### "));
    expect(
      headings.some((line) => line.includes(" · ")),
      "без момента разделителя в заголовке нет",
    ).toBe(false);
    // Имени у файла нет — подписью служит сам адрес.
    expect(
      text.includes(
        "- [https://files.example.test/c.bin](https://files.example.test/c.bin)",
      ),
    ).toBe(true);
  } finally {
    await stop();
  }
});

it("порядок комментариев: по created, при равных — по id", async () => {
  const { io, stop } = await stand({
    [CARD_PATH]: () => Response.json(EMPTY_CARD),
    [COMMENTS_PATH]: () =>
      Response.json([
        { id: 30, text: "третий", created: "2026-08-14T16:35:00.000Z" },
        { id: 20, text: "второй", created: "2026-08-14T16:33:00.000Z" },
        { id: 10, text: "первый", created: "2026-08-14T16:33:00.000Z" },
      ]),
    [PROPERTIES_PATH]: () => Response.json([]),
  });
  try {
    const result = await run([SELECTOR, "--json"], io);

    // Момент старше — раньше; при равных моментах разбирает id.
    expect(result.card.comments.map((comment) => comment.id)).toStrictEqual([
      10, 20, 30,
    ]);
  } finally {
    await stop();
  }
});
