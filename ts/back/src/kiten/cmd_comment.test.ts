/**
 * Команда `mpu kiten comment` (`docs/specs/kiten-comment.md`). Выводы всех
 * успешных ветвей закрыты голденами канала, снятыми живым прогоном; вход —
 * ответы внешней границы, а не подставленный результат: команда ходит в
 * каталог, каталог — в фейковый Kaiten на петле.
 *
 * Отдельно проверяется состав вызовов: карточка читается только ради
 * владельца, а ветви ошибок ввода не делают ни одного запроса.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import {
  type Command,
  type CommandIo,
  DomainError,
  formatCommandError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "@mpu/kaiten/testing";
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
  return readFile(
    new URL(`testdata/kiten-comment/${name}`, import.meta.url),
    "utf8",
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
      username: "ivanov",
    },
  });
}

/** Живая карточка; `patch` правит её под случай теста. */
async function card(
  patch: (raw: Record<string, unknown>) => void = () => {},
): Promise<Response> {
  const raw = JSON.parse(
    await readFile(
      new URL(
        "testdata/kiten-card/raw-card-file-property.json",
        import.meta.url,
      ),
      "utf8",
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

async function stand(
  routes: Routes,
  overrides: Partial<CommandIo> = {},
): Promise<Stand> {
  const fake = await startFakeKaiten((seen) => {
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

async function output(argv: readonly string[], io: CommandIo): Promise<string> {
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

describe("текст: один источник — один запрос", () => {
  it("-m: карточка не читается вовсе", async () => {
    const { io, baseUrl, seen, stop } = await stand({
      [POST_COMMENT]: () => comment(88017902),
    });
    try {
      expect(
        await output([SELECTOR, "-m", "Готово, проверьте"], io),
      ).toStrictEqual(await expected("ok-message-stdout.txt", baseUrl));
      expect(calls(seen)).toStrictEqual([POST_COMMENT]);
      expect(sentText(seen[0])).toBe("Готово, проверьте");
    } finally {
      await stop();
    }
  });

  it("-F -: текст из stdin", async () => {
    const { io, baseUrl, seen, stop } = await stand(
      {
        [POST_COMMENT]: () => comment(88017904),
      },
      {
        readStdin: () =>
          Promise.resolve(new TextEncoder().encode("из потока\n")),
      },
    );
    try {
      expect(await output([SELECTOR, "-F", "-"], io)).toStrictEqual(
        await expected("ok-stdin-stdout.txt", baseUrl),
      );
      expect(calls(seen)).toStrictEqual([POST_COMMENT]);
      expect(sentText(seen[0])).toBe("из потока\n");
    } finally {
      await stop();
    }
  });

  it("-F PATH: текст из файла", async () => {
    const { io, seen, stop } = await stand(
      {
        [POST_COMMENT]: () => comment(88017904),
      },
      { readTextFile: () => Promise.resolve("из файла") },
    );
    try {
      await output([SELECTOR, "-F", "/tmp/body.md"], io);
      expect(sentText(seen[0])).toBe("из файла");
    } finally {
      await stop();
    }
  });
});

describe("адресаты: раскрытие @all и дедуп", () => {
  it("--to '@all @teststub' и @all внутри текста", async () => {
    const { io, baseUrl, seen, stop } = await stand({
      [GET_CARD]: () => card(),
      [POST_COMMENT]: () => comment(88017903),
    });
    try {
      expect(
        await output(
          [SELECTOR, "--to", "@all @teststub", "-m", "@all, посмотрите"],
          io,
        ),
      ).toStrictEqual(await expected("ok-recipients-stdout.txt", baseUrl));
      // Карточка читается ради владельца и только один раз.
      expect(calls(seen)).toStrictEqual([GET_CARD, POST_COMMENT]);
      expect(sentText(seen[1])).toBe(
        "@ivanov @teststub\n\n@ivanov, посмотрите",
      );
    } finally {
      await stop();
    }
  });

  it("--to без текста: комментарий из одной строки", async () => {
    const { io, baseUrl, seen, stop } = await stand({
      [GET_CARD]: () => card(),
      [POST_COMMENT]: () => comment(88017938),
    });
    try {
      expect(await output([SELECTOR, "--to", "@teststub"], io)).toStrictEqual(
        await expected("ok-recipients-only-stdout.txt", baseUrl),
      );
      expect(sentText(seen[1])).toBe("@teststub");
    } finally {
      await stop();
    }
  });

  it("дубли без учёта регистра: первое вхождение", async () => {
    const { io, baseUrl, seen, stop } = await stand({
      [GET_CARD]: () => card(),
      [POST_COMMENT]: () => comment(88018160),
    });
    try {
      expect(
        await output([SELECTOR, "--to", "@Teststub @teststub"], io),
      ).toStrictEqual(
        await expected("ok-recipients-dedup-stdout.txt", baseUrl),
      );
      expect(sentText(seen[1])).toBe("@Teststub");
    } finally {
      await stop();
    }
  });

  it("@all только в тексте: карточка читается", async () => {
    const { io, seen, stop } = await stand({
      [GET_CARD]: () => card(),
      [POST_COMMENT]: () => comment(88017902),
    });
    try {
      const text = await output([SELECTOR, "-m", "@all, готово"], io);
      expect(calls(seen)).toStrictEqual([GET_CARD, POST_COMMENT]);
      expect(sentText(seen[1])).toBe("@ivanov, готово");
      // Адресатов не задавали — строки о них в выводе нет.
      expect(text.includes("адресаты")).toBe(false);
    } finally {
      await stop();
    }
  });

  it("владельца нет: предупреждение, @all как есть", async () => {
    const warnings: string[] = [];
    const { io, seen, stop } = await stand(
      {
        [GET_CARD]: () => card((raw) => (raw.owner = null)),
        [POST_COMMENT]: () => comment(88017938),
      },
      { progress: (line) => warnings.push(line) },
    );
    try {
      const text = await output([SELECTOR, "--to", "@all"], io);
      expect(warnings).toStrictEqual([
        "mpu kiten comment: у карточки нет владельца с username — " +
          "оставляю '@all' как есть",
      ]);
      expect(sentText(seen[1])).toBe("@all");
      expect(text.includes("адресаты")).toBe(false);
    } finally {
      await stop();
    }
  });
});

describe("вложения: файлы уходят вместе с текстом", () => {
  const bytes = () => Promise.resolve(new Uint8Array([112, 114]));

  it("одно вложение с текстом", async () => {
    const { io, baseUrl, seen, stop } = await stand(
      {
        [POST_COMMENT]: () => comment(88017935),
      },
      { readRegularFile: bytes },
    );
    try {
      expect(
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
      ).toStrictEqual(await expected("ok-attachment-stdout.txt", baseUrl));
      // Один запрос: текст и файл уходят вместе, частичной публикации нет.
      expect(calls(seen)).toStrictEqual([POST_COMMENT]);
      expect(seen[0].body.includes('filename="probe.txt"')).toBe(true);
    } finally {
      await stop();
    }
  });

  it("два вложения — разделитель и порядок флагов", async () => {
    const { io, baseUrl, seen, stop } = await stand(
      {
        [POST_COMMENT]: () => comment(88018158),
      },
      { readRegularFile: bytes },
    );
    try {
      expect(
        await output(
          [SELECTOR, "-f", "probe.txt", "-f", "probe2.txt", "-m", "два файла"],
          io,
        ),
      ).toStrictEqual(await expected("ok-attachment-two-stdout.txt", baseUrl));
      expect(calls(seen)).toStrictEqual([POST_COMMENT]);
    } finally {
      await stop();
    }
  });

  it("вложение с адресатами вместо своего текста", async () => {
    const { io, baseUrl, seen, stop } = await stand(
      {
        [GET_CARD]: () => card(),
        [POST_COMMENT]: () => comment(88017942),
      },
      { readRegularFile: bytes },
    );
    try {
      expect(
        await output([SELECTOR, "-f", "probe.txt", "--to", "@teststub"], io),
      ).toStrictEqual(
        await expected("ok-attachment-recipients-stdout.txt", baseUrl),
      );
      expect(calls(seen)).toStrictEqual([GET_CARD, POST_COMMENT]);
    } finally {
      await stop();
    }
  });
});

describe("ошибки ввода: ни одного запроса", () => {
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
    ["ни одного источника", [SELECTOR], "err-no-text-message.txt", {}],
  ];
  for (const [name, argv, file, overrides] of cases) {
    it(name, async () => {
      const { io, seen, stop } = await stand({}, overrides);
      try {
        const err = await rejected(() => output(argv, io), UsageError);
        expect(err.message).toStrictEqual((await golden(file)).trim());
        expect(calls(seen)).toStrictEqual([]);
      } finally {
        await stop();
      }
    });
  }

  it("вложение без текста и без адресатов", async () => {
    // Отклонение с вердиктом fix: прежняя реализация отправляла запрос и
    // получала 400. Здесь запроса нет вовсе.
    const { io, seen, stop } = await stand(
      {},
      {
        readRegularFile: () => Promise.resolve(new Uint8Array()),
      },
    );
    try {
      const err = await rejected(
        () => output([SELECTOR, "-f", "probe.txt"], io),
        UsageError,
      );
      expect(err.message).toBe(
        "нужен текст комментария: вложения без текста Kaiten не принимает",
      );
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });

  it("вложения нет на диске", async () => {
    const path = "/home/user/tmp/нет-такого.txt";
    const { io, seen, stop } = await stand(
      {},
      {
        readRegularFile: () => Promise.reject(new NotFoundIoError("нет")),
      },
    );
    try {
      const err = await rejected(
        () => output([SELECTOR, "-m", "текст", "-f", path], io),
        UsageError,
      );
      expect(err.message).toStrictEqual(
        (await golden("err-file-not-found-message.txt")).trim(),
      );
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });

  it("вложение не читается", async () => {
    const { io, stop } = await stand(
      {},
      {
        readRegularFile: () => Promise.reject(new Error("permission denied")),
      },
    );
    try {
      const err = await rejected(
        () => output([SELECTOR, "-m", "текст", "-f", "probe.txt"], io),
        UsageError,
      );
      expect(err.message).toBe(
        "не удалось прочитать вложение probe.txt: permission denied",
      );
    } finally {
      await stop();
    }
  });

  it("файл текста не читается", async () => {
    const { io, seen, stop } = await stand(
      {},
      {
        readTextFile: () =>
          Promise.reject(new NotFoundIoError("file not found")),
      },
    );
    try {
      const err = await rejected(
        () => output([SELECTOR, "-F", "/tmp/нет.md"], io),
        UsageError,
      );
      expect(err.message).toBe(
        "не удалось прочитать /tmp/нет.md: file not found",
      );
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });

  it("текст из одних пробелов", async () => {
    const { io, seen, stop } = await stand({});
    try {
      const err = await rejected(
        () => output([SELECTOR, "-m", "   ", "--to", "@teststub"], io),
        UsageError,
      );
      expect(err.message).toBe("пустой текст комментария");
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });

  it("--to без единого токена текста не даёт", async () => {
    // Флаг есть, адресата нет: комментарий остался бы без текста, а его
    // Kaiten не принимает — отбиваем до сети, как и голые вложения.
    const { io, seen, stop } = await stand({});
    try {
      const err = await rejected(
        () => output([SELECTOR, "--to", "   "], io),
        UsageError,
      );
      expect(err.message).toStrictEqual(
        (await golden("err-no-text-message.txt")).trim(),
      );
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });

  it("селектор без числового сегмента", async () => {
    const { io, seen, stop } = await stand({});
    try {
      await expect(output(["board/abc", "-m", "текст"], io)).rejects.toThrow(
        UsageError,
      );
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });
});

it("--to '' с текстом: карточка не читается", async () => {
  const { io, seen, stop } = await stand({
    [POST_COMMENT]: () => comment(88017902),
  });
  try {
    await output([SELECTOR, "--to", "", "-m", "текст"], io);
    expect(calls(seen)).toStrictEqual([POST_COMMENT]);
    expect(sentText(seen[0])).toBe("текст");
  } finally {
    await stop();
  }
});

it("@all в тексте без владельца остаётся как есть", async () => {
  const warnings: string[] = [];
  const { io, seen, stop } = await stand(
    {
      [GET_CARD]: () => card((raw) => (raw.owner = null)),
      [POST_COMMENT]: () => comment(88017902),
    },
    { progress: (line) => warnings.push(line) },
  );
  try {
    await output([SELECTOR, "-m", "@all, готово"], io);
    expect(warnings.length).toBe(1);
    expect(sentText(seen[1])).toBe("@all, готово");
  } finally {
    await stop();
  }
});

it("отказ API на ветви с вложениями — exit 1", async () => {
  const { io, seen, stop } = await stand(
    {
      [POST_COMMENT]: () => new Response("", { status: 403 }),
    },
    { readRegularFile: () => Promise.resolve(new Uint8Array([1])) },
  );
  try {
    await expect(
      output([SELECTOR, "-m", "текст", "-f", "probe.txt"], io),
    ).rejects.toThrow(DomainError);
    expect(calls(seen)).toStrictEqual([POST_COMMENT]);
  } finally {
    await stop();
  }
});

it("отказ API — exit 1 с полным путём команды", async () => {
  const { io, seen, stop } = await stand({
    [POST_COMMENT]: () => new Response("", { status: 403 }),
  });
  try {
    const err = await rejected(
      () => output([SELECTOR, "-m", "текст"], io),
      DomainError,
    );
    expect(
      formatCommandError("kiten comment", err).startsWith(
        "mpu kiten comment: kaiten error: ",
      ),
    ).toBe(true);
    expect(calls(seen)).toStrictEqual([POST_COMMENT]);
  } finally {
    await stop();
  }
});

it("ненастроенный KITEN_API_KEY — ошибка ввода", async () => {
  const io = makeFakeIo({
    envFile: {
      get: () => undefined,
      values: () => ({}),
      require: () => "",
      set: () => Promise.resolve(),
    },
  });
  await expect(
    kitenCommentCommand.invoke([SELECTOR, "-m", "текст"], io),
  ).rejects.toThrow(UsageError);
});
