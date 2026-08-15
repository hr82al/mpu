/**
 * Команда `mpu kiten comment` (`docs/specs/kiten-comment.md`). Выводы всех
 * успешных ветвей закрыты голденами канала, снятыми живым прогоном; вход —
 * ответы внешней границы, а не подставленный результат: команда ходит в
 * каталог, каталог — в фейковый Kaiten на петле.
 *
 * Отдельно проверяется состав вызовов: карточка читается только ради
 * владельца, а ветви ошибок ввода не делают ни одного запроса.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  type Command,
  type CommandIo,
  DomainError,
  formatCommandError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
import { kitenCommentCommand } from "./mod.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";
const CARD_ID = 10000001;
const SELECTOR = String(CARD_ID);

const CARD_PATH = `/api/latest/cards/${CARD_ID}`;
const COMMENTS_PATH = `${CARD_PATH}/comments`;
const GET_CARD = `GET ${CARD_PATH}`;
const POST_COMMENT = `POST ${COMMENTS_PATH}`;

/** Адрес карточки в голденах: снят с обезличенного живого прогона. */
const GOLDEN_CARD_URL = `https://kaiten.example.test/${CARD_ID}`;

function golden(name: string): Promise<string> {
  return Deno.readTextFile(
    new URL(`testdata/kiten-comment/${name}`, import.meta.url),
  );
}

async function expected(name: string, baseUrl: string): Promise<string> {
  return (await golden(name)).replaceAll(
    GOLDEN_CARD_URL,
    `${baseUrl}/${CARD_ID}`,
  );
}

/** Ответ создания комментария: значим в нём только id. */
function comment(id: number): Response {
  return Response.json({
    id,
    text: "что бы ни ушло, вывод берёт отсюда только id",
    created: "2026-08-14T16:35:38.592Z",
    author: {
      id: 700001,
      full_name: "Иванов Иван",
      email: null,
      username: "ivanov",
    },
  });
}

/** Живая карточка; `patch` правит её под случай теста. */
async function card(
  patch: (raw: Record<string, unknown>) => void = () => {},
): Promise<Response> {
  const raw = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "testdata/kiten-card/raw-card-file-property.json",
        import.meta.url,
      ),
    ),
  );
  patch(raw);
  return Response.json(raw);
}

type Routes = Readonly<Record<string, () => Response | Promise<Response>>>;

interface Stand {
  readonly io: CommandIo;
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly stop: () => Promise<void>;
}

function stand(routes: Routes, overrides: Partial<CommandIo> = {}): Stand {
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    const route = routes[`${last.method} ${last.pathname}`];
    return route === undefined
      ? new Response("вызов, которого тест не ждал", { status: 500 })
      : route();
  });
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: API_KEY,
    KITEN_BASE_URL: fake.baseUrl,
  };
  const io = makeFakeIo({
    envFile: {
      get: (name) => values[name],
      values: () => values,
      require: (name) => values[name] ?? "",
      set: () => Promise.resolve(),
    },
    ...overrides,
  });
  return { io, baseUrl: fake.baseUrl, seen: fake.seen, stop: fake.stop };
}

async function output(
  argv: readonly string[],
  io: CommandIo,
): Promise<string> {
  const command: Command = kitenCommentCommand;
  return command.renderResult(await command.invoke(argv, io), argv);
}

function calls(seen: readonly CapturedRequest[]): readonly string[] {
  return seen.map((request) => `${request.method} ${request.pathname}`);
}

/** Текст комментария так, как его увидел сервер (JSON-форма). */
function sentText(request: CapturedRequest): string {
  return JSON.parse(request.body).text;
}

Deno.test("текст: один источник — один запрос", async (t) => {
  await t.step("-m: карточка не читается вовсе", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [POST_COMMENT]: () => comment(88017902),
    });
    try {
      assertEquals(
        await output([SELECTOR, "-m", "Готово, проверьте"], io),
        await expected("ok-message-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [POST_COMMENT]);
      assertEquals(sentText(seen[0]), "Готово, проверьте");
    } finally {
      await stop();
    }
  });

  await t.step("-F -: текст из stdin", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [POST_COMMENT]: () => comment(88017904),
    }, { readTextStdin: () => Promise.resolve("из потока\n") });
    try {
      assertEquals(
        await output([SELECTOR, "-F", "-"], io),
        await expected("ok-stdin-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [POST_COMMENT]);
      assertEquals(sentText(seen[0]), "из потока\n");
    } finally {
      await stop();
    }
  });

  await t.step("-F PATH: текст из файла", async () => {
    const { io, seen, stop } = stand({
      [POST_COMMENT]: () => comment(88017904),
    }, { readTextFile: () => Promise.resolve("из файла") });
    try {
      await output([SELECTOR, "-F", "/tmp/body.md"], io);
      assertEquals(sentText(seen[0]), "из файла");
    } finally {
      await stop();
    }
  });
});

Deno.test("адресаты: раскрытие @all и дедуп", async (t) => {
  await t.step("--to '@all @teststub' и @all внутри текста", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [GET_CARD]: () => card(),
      [POST_COMMENT]: () => comment(88017903),
    });
    try {
      assertEquals(
        await output(
          [SELECTOR, "--to", "@all @teststub", "-m", "@all, посмотрите"],
          io,
        ),
        await expected("ok-recipients-stdout.txt", baseUrl),
      );
      // Карточка читается ради владельца и только один раз.
      assertEquals(calls(seen), [GET_CARD, POST_COMMENT]);
      assertEquals(
        sentText(seen[1]),
        "@ivanov @teststub\n\n@ivanov, посмотрите",
      );
    } finally {
      await stop();
    }
  });

  await t.step("--to без текста: комментарий из одной строки", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [GET_CARD]: () => card(),
      [POST_COMMENT]: () => comment(88017938),
    });
    try {
      assertEquals(
        await output([SELECTOR, "--to", "@teststub"], io),
        await expected("ok-recipients-only-stdout.txt", baseUrl),
      );
      assertEquals(sentText(seen[1]), "@teststub");
    } finally {
      await stop();
    }
  });

  await t.step("дубли без учёта регистра: первое вхождение", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [GET_CARD]: () => card(),
      [POST_COMMENT]: () => comment(88018160),
    });
    try {
      assertEquals(
        await output([SELECTOR, "--to", "@Teststub @teststub"], io),
        await expected("ok-recipients-dedup-stdout.txt", baseUrl),
      );
      assertEquals(sentText(seen[1]), "@Teststub");
    } finally {
      await stop();
    }
  });

  await t.step("@all только в тексте: карточка читается", async () => {
    const { io, seen, stop } = stand({
      [GET_CARD]: () => card(),
      [POST_COMMENT]: () => comment(88017902),
    });
    try {
      const text = await output([SELECTOR, "-m", "@all, готово"], io);
      assertEquals(calls(seen), [GET_CARD, POST_COMMENT]);
      assertEquals(sentText(seen[1]), "@ivanov, готово");
      // Адресатов не задавали — строки о них в выводе нет.
      assertEquals(text.includes("адресаты"), false);
    } finally {
      await stop();
    }
  });

  await t.step("владельца нет: предупреждение, @all как есть", async () => {
    const warnings: string[] = [];
    const { io, seen, stop } = stand({
      [GET_CARD]: () => card((raw) => raw.owner = null),
      [POST_COMMENT]: () => comment(88017938),
    }, { progress: (line) => warnings.push(line) });
    try {
      const text = await output([SELECTOR, "--to", "@all"], io);
      assertEquals(warnings, [
        "mpu kiten comment: у карточки нет владельца с username — " +
        "оставляю '@all' как есть",
      ]);
      assertEquals(sentText(seen[1]), "@all");
      assertEquals(text.includes("адресаты"), false);
    } finally {
      await stop();
    }
  });
});

Deno.test("вложения: файлы уходят вместе с текстом", async (t) => {
  const bytes = () => Promise.resolve(new Uint8Array([112, 114]));

  await t.step("одно вложение с текстом", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [POST_COMMENT]: () => comment(88017935),
    }, { readRegularFile: bytes });
    try {
      assertEquals(
        await output(
          [
            SELECTOR,
            "-f",
            "/home/user/tmp/probe.txt",
            "-m",
            "файл во вложении",
          ],
          io,
        ),
        await expected("ok-attachment-stdout.txt", baseUrl),
      );
      // Один запрос: текст и файл уходят вместе, частичной публикации нет.
      assertEquals(calls(seen), [POST_COMMENT]);
      assertEquals(seen[0].body.includes('filename="probe.txt"'), true);
    } finally {
      await stop();
    }
  });

  await t.step("два вложения — разделитель и порядок флагов", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [POST_COMMENT]: () => comment(88018158),
    }, { readRegularFile: bytes });
    try {
      assertEquals(
        await output(
          [SELECTOR, "-f", "probe.txt", "-f", "probe2.txt", "-m", "два файла"],
          io,
        ),
        await expected("ok-attachment-two-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [POST_COMMENT]);
    } finally {
      await stop();
    }
  });

  await t.step("вложение с адресатами вместо своего текста", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [GET_CARD]: () => card(),
      [POST_COMMENT]: () => comment(88017942),
    }, { readRegularFile: bytes });
    try {
      assertEquals(
        await output([SELECTOR, "-f", "probe.txt", "--to", "@teststub"], io),
        await expected("ok-attachment-recipients-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [GET_CARD, POST_COMMENT]);
    } finally {
      await stop();
    }
  });
});

Deno.test("ошибки ввода: ни одного запроса", async (t) => {
  const cases: readonly [
    string,
    readonly string[],
    string,
    Partial<CommandIo>,
  ][] = [
    [
      "оба источника текста",
      [SELECTOR, "-m", "текст", "-F", "/tmp/body.md"],
      "err-both-sources-message.txt",
      {},
    ],
    [
      "ни одного источника",
      [SELECTOR],
      "err-no-text-message.txt",
      {},
    ],
  ];
  for (const [name, argv, file, overrides] of cases) {
    await t.step(name, async () => {
      const { io, seen, stop } = stand({}, overrides);
      try {
        const err = await assertRejects(
          () => output(argv, io),
          UsageError,
        );
        assertEquals(err.message, (await golden(file)).trim());
        assertEquals(calls(seen), []);
      } finally {
        await stop();
      }
    });
  }

  await t.step("вложение без текста и без адресатов", async () => {
    // Отклонение с вердиктом fix: прежняя реализация отправляла запрос и
    // получала 400. Здесь запроса нет вовсе.
    const { io, seen, stop } = stand({}, {
      readRegularFile: () => Promise.resolve(new Uint8Array()),
    });
    try {
      const err = await assertRejects(
        () => output([SELECTOR, "-f", "probe.txt"], io),
        UsageError,
      );
      assertEquals(
        err.message,
        "нужен текст комментария: вложения без текста Kaiten не принимает",
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("вложения нет на диске", async () => {
    const path = "/home/user/tmp/нет-такого.txt";
    const { io, seen, stop } = stand({}, {
      readRegularFile: () => Promise.reject(new NotFoundIoError("нет")),
    });
    try {
      const err = await assertRejects(
        () => output([SELECTOR, "-m", "текст", "-f", path], io),
        UsageError,
      );
      assertEquals(
        err.message,
        (await golden("err-file-not-found-message.txt")).trim(),
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("вложение не читается", async () => {
    const { io, stop } = stand({}, {
      readRegularFile: () => Promise.reject(new Error("permission denied")),
    });
    try {
      const err = await assertRejects(
        () => output([SELECTOR, "-m", "текст", "-f", "probe.txt"], io),
        UsageError,
      );
      assertEquals(
        err.message,
        "не удалось прочитать вложение probe.txt: permission denied",
      );
    } finally {
      await stop();
    }
  });

  await t.step("файл текста не читается", async () => {
    const { io, seen, stop } = stand({}, {
      readTextFile: () => Promise.reject(new NotFoundIoError("file not found")),
    });
    try {
      const err = await assertRejects(
        () => output([SELECTOR, "-F", "/tmp/нет.md"], io),
        UsageError,
      );
      assertEquals(
        err.message,
        "не удалось прочитать /tmp/нет.md: file not found",
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("текст из одних пробелов", async () => {
    const { io, seen, stop } = stand({});
    try {
      const err = await assertRejects(
        () => output([SELECTOR, "-m", "   ", "--to", "@teststub"], io),
        UsageError,
      );
      assertEquals(err.message, "пустой текст комментария");
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("--to без единого токена текста не даёт", async () => {
    // Флаг есть, адресата нет: комментарий остался бы без текста, а его
    // Kaiten не принимает — отбиваем до сети, как и голые вложения.
    const { io, seen, stop } = stand({});
    try {
      const err = await assertRejects(
        () => output([SELECTOR, "--to", "   "], io),
        UsageError,
      );
      assertEquals(
        err.message,
        (await golden("err-no-text-message.txt")).trim(),
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("селектор без числового сегмента", async () => {
    const { io, seen, stop } = stand({});
    try {
      await assertRejects(
        () => output(["board/abc", "-m", "текст"], io),
        UsageError,
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });
});

Deno.test("--to '' с текстом: карточка не читается", async () => {
  const { io, seen, stop } = stand({ [POST_COMMENT]: () => comment(88017902) });
  try {
    await output([SELECTOR, "--to", "", "-m", "текст"], io);
    assertEquals(calls(seen), [POST_COMMENT]);
    assertEquals(sentText(seen[0]), "текст");
  } finally {
    await stop();
  }
});

Deno.test("@all в тексте без владельца остаётся как есть", async () => {
  const warnings: string[] = [];
  const { io, seen, stop } = stand({
    [GET_CARD]: () => card((raw) => raw.owner = null),
    [POST_COMMENT]: () => comment(88017902),
  }, { progress: (line) => warnings.push(line) });
  try {
    await output([SELECTOR, "-m", "@all, готово"], io);
    assertEquals(warnings.length, 1);
    assertEquals(sentText(seen[1]), "@all, готово");
  } finally {
    await stop();
  }
});

Deno.test("отказ API на ветви с вложениями — exit 1", async () => {
  const { io, seen, stop } = stand({
    [POST_COMMENT]: () => new Response("", { status: 403 }),
  }, { readRegularFile: () => Promise.resolve(new Uint8Array([1])) });
  try {
    await assertRejects(
      () => output([SELECTOR, "-m", "текст", "-f", "probe.txt"], io),
      DomainError,
    );
    assertEquals(calls(seen), [POST_COMMENT]);
  } finally {
    await stop();
  }
});

Deno.test("отказ API — exit 1 с полным путём команды", async () => {
  const { io, seen, stop } = stand({
    [POST_COMMENT]: () => new Response("", { status: 403 }),
  });
  try {
    const err = await assertRejects(
      () => output([SELECTOR, "-m", "текст"], io),
      DomainError,
    );
    assertEquals(
      formatCommandError("kiten comment", err).startsWith(
        "mpu kiten comment: kaiten error: ",
      ),
      true,
    );
    assertEquals(calls(seen), [POST_COMMENT]);
  } finally {
    await stop();
  }
});

Deno.test("ненастроенный KITEN_API_KEY — ошибка ввода", async () => {
  const io = makeFakeIo({
    envFile: {
      get: () => undefined,
      values: () => ({}),
      require: () => "",
      set: () => Promise.resolve(),
    },
  });
  await assertRejects(
    () => kitenCommentCommand.invoke([SELECTOR, "-m", "текст"], io),
    UsageError,
  );
});
