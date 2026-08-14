/**
 * Команда `mpu kiten card` (`docs/specs/kiten-card.md`). Три вида вывода
 * закрыты голденами канала: живой комплект снят на тестовой карточке
 * Kaiten, синтетический собран ради ветвей, которых на живой карточке нет
 * (непустой `key`, непустые `members`, свойство вне справочника имён).
 *
 * Вход тестов — ответы внешней границы из тех же голденов, а не
 * подставленный порт: команда ходит в каталог, каталог — в фейковый Kaiten
 * на петле (`../kaiten/testing.ts`). Так проверяется и то, каких запросов
 * команда НЕ делает: справочника имён на `--json`, комментариев на
 * `--no-comments`.
 *
 * Вызов идёт от argv, как из точки входа: разбор делает схема самой
 * команды, поэтому под проверку попадают и формы записи флагов, включая
 * отрицательные `--no-*`.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
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
  return Deno.readTextFile(new URL(`testdata/${name}`, import.meta.url));
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

function stand(routes: Routes, terminal = false): Stand {
  const fake = startFakeKaiten((seen) => {
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
async function output(
  argv: readonly string[],
  io: CommandIo,
): Promise<string> {
  return kitenCardCommand.renderResult(await run(argv, io), argv);
}

/** Пути запросов в порядке обращения: наблюдаемый состав вызовов. */
function paths(seen: readonly CapturedRequest[]): readonly string[] {
  return seen.map((request) => request.pathname);
}

Deno.test("живая карточка: три вида вывода сходятся с голденами", async (t) => {
  const live: Routes = {
    [CARD_PATH]: () => body("live-raw-card.json"),
    [COMMENTS_PATH]: () => body("live-raw-comments.json"),
    [PROPERTIES_PATH]: () => Response.json(LIVE_PROPERTIES),
  };

  await t.step("--json: сырой JSON, справочник не запрашивается", async () => {
    const { io, baseUrl, seen, stop } = stand(live);
    try {
      assertEquals(
        await output([SELECTOR, "--json"], io),
        await expected("live-json-stdout.json", baseUrl),
      );
      // Имена полей JSON-выводу не нужны — и запроса за ними нет
      // (`kiten-card.md`, «Известные отклонения»).
      assertEquals(paths(seen), [CARD_PATH, COMMENTS_PATH]);
    } finally {
      await stop();
    }
  });

  await t.step("--json не зависит от --images", async () => {
    const { io, baseUrl, stop } = stand(live);
    try {
      assertEquals(
        await output([SELECTOR, "--json", "--no-images"], io),
        await expected("live-json-stdout.json", baseUrl),
      );
    } finally {
      await stop();
    }
  });

  await t.step("--md: комментарии отсортированы по created", async () => {
    const { io, baseUrl, seen, stop } = stand(live);
    try {
      // Вход неупорядочен — седьмой по времени комментарий приходит
      // шестым; вывод по возрастанию `created`. Пара «этот вход → этот
      // голден» и проверяет сортировку.
      assertEquals(
        await output([SELECTOR, "--md"], io),
        await expected("live-md-stdout.md", baseUrl),
      );
      assertEquals(paths(seen).length, 3);
    } finally {
      await stop();
    }
  });

  await t.step("--no-comments: раздела нет и запроса нет", async () => {
    const { io, baseUrl, seen, stop } = stand(live);
    try {
      const argv = [SELECTOR, "--md", "--no-comments"];
      const result = await run(argv, io);

      assertEquals(
        kitenCardCommand.renderResult(result, argv),
        await expected("live-md-no-comments-stdout.md", baseUrl),
      );
      assertEquals(result.card.comments, []);
      assertEquals(paths(seen), [CARD_PATH, PROPERTIES_PATH]);
    } finally {
      await stop();
    }
  });
});

Deno.test("синтетическая карточка: key, участники, поле вне справочника", async (t) => {
  const synthetic: Routes = {
    [CARD_PATH]: () => body("synthetic-card-detail.json"),
    [COMMENTS_PATH]: () => body("synthetic-comments.json"),
    [PROPERTIES_PATH]: () => Response.json(SYNTHETIC_PROPERTIES),
  };

  await t.step("--json", async () => {
    const { io, baseUrl, stop } = stand(synthetic);
    try {
      assertEquals(
        await output([SELECTOR, "--json"], io),
        await expected("synthetic-json-stdout.json", baseUrl),
      );
    } finally {
      await stop();
    }
  });

  await t.step("--md: неизвестное поле печатается сырым ключом", async () => {
    const { io, baseUrl, stop } = stand(synthetic);
    try {
      assertEquals(
        await output([SELECTOR, "--md"], io),
        await expected("synthetic-md-stdout.md", baseUrl),
      );
    } finally {
      await stop();
    }
  });

  await t.step("--md --no-comments", async () => {
    const { io, baseUrl, stop } = stand(synthetic);
    try {
      assertEquals(
        await output([SELECTOR, "--md", "--no-comments"], io),
        await expected("synthetic-md-no-comments-stdout.md", baseUrl),
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("пустая карточка: строки шапки без значения не печатаются", async (t) => {
  const empty: Routes = {
    [CARD_PATH]: () => Response.json(EMPTY_CARD),
    [COMMENTS_PATH]: () => Response.json([]),
    [PROPERTIES_PATH]: () => Response.json([]),
  };

  await t.step(
    "--json: properties {}, comments [], ключи на месте",
    async () => {
      const { io, baseUrl, stop } = stand(empty);
      try {
        assertEquals(
          await output([SELECTOR, "--json"], io),
          await expected("live-empty-json-stdout.json", baseUrl),
        );
      } finally {
        await stop();
      }
    },
  );

  await t.step("--md: «нет описания», URL и Этап остаются", async () => {
    const { io, baseUrl, stop } = stand(empty);
    try {
      assertEquals(
        await output([SELECTOR, "--md"], io),
        await expected("live-empty-md-stdout.md", baseUrl),
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("файловое поле: массив в JSON, элементы через запятую в markdown", async (t) => {
  const withFile: Routes = {
    [CARD_PATH]: () => body("raw-card-file-property.json"),
    [COMMENTS_PATH]: () => Response.json([]),
    [PROPERTIES_PATH]: () =>
      Response.json([...LIVE_PROPERTIES, {
        id: 610303,
        name: "9. AI-артефакт",
        type: "file",
      }]),
  };

  await t.step("JSON: массив остаётся массивом", async () => {
    const { io, stop } = stand(withFile);
    try {
      const result = await run([SELECTOR, "--json"], io);

      assertEquals(result.card.properties.id_610303, [
        "99536012-bcad-4801-bfe7-30c958fcbf22",
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("markdown: два элемента — через `, `", async () => {
    // У живого входа в поле один uid, и разделитель на нём недоказуем:
    // склейка пустой строкой дала бы тот же текст.
    const { io, stop } = stand({
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

      assertEquals(text.includes("- 9. AI-артефакт: uid-1, uid-2"), true);
    } finally {
      await stop();
    }
  });

  await t.step(
    "markdown: элементы через `, `, без скобок и кавычек",
    async () => {
      const { io, stop } = stand(withFile);
      try {
        const text = await output([SELECTOR, "--md"], io);

        assertEquals(
          text.includes(
            "- 9. AI-артефакт: 99536012-bcad-4801-bfe7-30c958fcbf22",
          ),
          true,
          "значение-массив печатается элементами, а не представлением списка",
        );
      } finally {
        await stop();
      }
    },
  );
});

Deno.test("справочник имён не ответил: сырые ключи, команда не падает", async () => {
  const { io, stop } = stand({
    [CARD_PATH]: () => body("live-raw-card.json"),
    [COMMENTS_PATH]: () => Response.json([]),
    [PROPERTIES_PATH]: () => new Response("boom", { status: 500 }),
  });
  try {
    const text = await output([SELECTOR, "--md"], io);

    assertEquals(text.includes("- id_291984: "), true, "печатается сырой ключ");
    assertEquals(text.includes("6. Причина/гипотеза"), false);
  } finally {
    await stop();
  }
});

Deno.test("выбор вида: терминал — наглядный, пайп — markdown", async (t) => {
  const routes: Routes = {
    [CARD_PATH]: () => Response.json(EMPTY_CARD),
    [COMMENTS_PATH]: () => Response.json([]),
    [PROPERTIES_PATH]: () => Response.json([]),
  };

  await t.step("stdout не терминал — markdown", async () => {
    const { io, stop } = stand(routes);
    try {
      assertEquals((await run([SELECTOR], io)).view, "md");
    } finally {
      await stop();
    }
  });

  await t.step("stdout терминал — наглядный вид", async () => {
    const { io, stop } = stand(routes, true);
    try {
      const result = await run([SELECTOR], io);
      const text = kitenCardCommand.renderResult(result, [SELECTOR]);

      assertEquals(result.view, "pretty");
      // Оформление — свобода реализации, но markdown-разметки в нём нет.
      assertEquals(text.includes("\x1b[1mтест\x1b[0m"), true);
      assertEquals(text.includes("# тест"), false);
    } finally {
      await stop();
    }
  });

  await t.step("--md побеждает терминальность stdout", async () => {
    const { io, stop } = stand(routes, true);
    try {
      assertEquals((await run([SELECTOR, "--md"], io)).view, "md");
    } finally {
      await stop();
    }
  });

  await t.step("--json побеждает --md", async () => {
    const { io, stop } = stand(routes, true);
    try {
      assertEquals((await run([SELECTOR, "--md", "--json"], io)).view, "json");
    } finally {
      await stop();
    }
  });
});

Deno.test("--no-images: картинки-вложения уходят из наглядного вида", async () => {
  const { io, stop } = stand({
    [CARD_PATH]: () =>
      Response.json({
        ...EMPTY_CARD,
        files: [
          { id: 1, url: "https://files.example.test/a.png", name: "схема.png" },
          { id: 2, url: "https://files.example.test/b.txt", name: "лог.txt" },
        ],
      }),
    [COMMENTS_PATH]: () => Response.json([]),
    [PROPERTIES_PATH]: () => Response.json([]),
  }, true);
  try {
    const shown = await output([SELECTOR], io);
    const hidden = await output([SELECTOR, "--no-images"], io);

    assertEquals(shown.includes("схема.png"), true);
    assertEquals(hidden.includes("схема.png"), false);
    // Прочие вложения флаг не трогает.
    assertEquals(hidden.includes("лог.txt"), true);
  } finally {
    await stop();
  }
});

Deno.test("недоступная карточка: 403 с пустым телом, exit 1", async () => {
  const { io, seen, stop } = stand({
    "/api/latest/cards/99999999": () => new Response(null, { status: 403 }),
  });
  try {
    const err = await assertRejects(
      () => run(["99999999"], io),
      DomainError,
    );

    assertEquals(
      `${formatCommandError(kitenCardCommand.errorName, err)}\n`,
      await golden("err-not-found-stderr.txt"),
    );
    // Комментарии и справочник не запрашиваются: карточки нет.
    assertEquals(paths(seen), ["/api/latest/cards/99999999"]);
  } finally {
    await stop();
  }
});

Deno.test("невалидный селектор: exit 2, без единого запроса", async () => {
  const { io, seen, stop } = stand({});
  try {
    const err = await assertRejects(() => run(["abc"], io), UsageError);

    assertEquals(`${err.message}\n`, await golden("err-selector-message.txt"));
    assertEquals(seen, []);
  } finally {
    await stop();
  }
});

Deno.test("метка этапа: закрытый список и число вне его", async (t) => {
  const cases: readonly (readonly [number, string])[] = [
    [1, "queued"],
    [2, "in progress"],
    [3, "done"],
    [7, "7"],
  ];
  for (const [state, label] of cases) {
    await t.step(`${state} → ${label}`, async () => {
      const { io, stop } = stand({
        [CARD_PATH]: () => Response.json({ ...EMPTY_CARD, state }),
        [COMMENTS_PATH]: () => Response.json([]),
        [PROPERTIES_PATH]: () => Response.json([]),
      });
      try {
        assertEquals((await run([SELECTOR, "--json"], io)).card.state, label);
      } finally {
        await stop();
      }
    });
  }
});

Deno.test("наглядный вид: свойства и комментарии без markdown-разметки", async () => {
  const { io, stop } = stand({
    [CARD_PATH]: () =>
      Response.json({
        ...EMPTY_CARD,
        properties: { id_291984: "гипотеза", id_610303: ["uid-1", "uid-2"] },
      }),
    [COMMENTS_PATH]: () =>
      Response.json([{
        id: 5001,
        text: "первый",
        created: "2026-08-14T16:33:42.672Z",
        author: { id: 700001, full_name: "Иванов Иван", username: "ivanov" },
      }]),
    [PROPERTIES_PATH]: () => Response.json(LIVE_PROPERTIES),
  }, true);
  try {
    const text = await output([SELECTOR], io);

    assertEquals(text.includes("\x1b[1mСвойства\x1b[0m"), true);
    assertEquals(text.includes("6. Причина/гипотеза: гипотеза"), true);
    // Значение-массив и в наглядном виде печатается элементами.
    assertEquals(text.includes("id_610303: uid-1, uid-2"), true);
    assertEquals(text.includes("\x1b[1mКомментарии\x1b[0m"), true);
    assertEquals(
      text.includes("\x1b[1mИванов Иван · 2026-08-14 16:33\x1b[0m"),
      true,
    );
    assertEquals(text.includes("## "), false);
  } finally {
    await stop();
  }
});

Deno.test("границы markdown: нет автора, нет момента, файл без имени", async () => {
  const { io, stop } = stand({
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
    assertEquals(text.includes("### —\n"), true);
    assertEquals(text.includes("### Петрова Мария\n"), true);
    const headings = text.split("\n").filter((line) => line.startsWith("### "));
    assertEquals(
      headings.some((line) => line.includes(" · ")),
      false,
      "без момента разделителя в заголовке нет",
    );
    // Имени у файла нет — подписью служит сам адрес.
    assertEquals(
      text.includes(
        "- [https://files.example.test/c.bin](https://files.example.test/c.bin)",
      ),
      true,
    );
  } finally {
    await stop();
  }
});

Deno.test("порядок комментариев: по created, при равных — по id", async () => {
  const { io, stop } = stand({
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
    assertEquals(result.card.comments.map((comment) => comment.id), [
      10,
      20,
      30,
    ]);
  } finally {
    await stop();
  }
});
