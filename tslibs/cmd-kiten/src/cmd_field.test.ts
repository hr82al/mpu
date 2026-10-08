/**
 * Команды `mpu kiten field` (`docs/specs/kiten-field.md`). Выводы всех
 * успешных ветвей закрыты голденами канала, снятыми живым прогоном; вход
 * ветвей `artefact rm` — живой ответ карточки с файлом поля
 * (`raw-card-file-property.json`), потому что привязку к полю показывает
 * именно он.
 *
 * Вызов идёт от argv, как из точки входа, а каталог ходит в фейковый
 * Kaiten на петле (`@mpu/kaiten/testing`): так под проверку попадает и
 * состав запросов — какие ушли, в каком порядке и чего в них нет.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import {
  type CommandIo,
  DomainError,
  formatCommandError,
  NotFoundIoError,
  UsageError,
} from "@mpu/command";
import { makeFakeIo } from "@mpu/command/testing";
import { type CapturedRequest, startFakeKaiten } from "@mpu/kaiten/testing";
import {
  kitenArtefactRmCommand,
  kitenArtefactSetCommand,
  kitenFieldSetCommand,
} from "./cmd_field.ts";
import type { Command } from "@mpu/command";

const API_KEY = "proba-kaiten-key-Q3z8Nw";
const CARD_ID = 10000001;
const SELECTOR = String(CARD_ID);

const CARD_PATH = `/api/latest/cards/${CARD_ID}`;
const ARTEFACT_FILES_PATH = `${CARD_PATH}/custom-properties/610303/files`;
const filePath = (fileId: number) => `${CARD_PATH}/files/${fileId}`;

/** Адрес карточки в голденах: снят с обезличенного живого прогона. */
const GOLDEN_CARD_URL = `https://kaiten.example.test/${CARD_ID}`;

function golden(name: string): Promise<string> {
  return readFile(
    new URL(`testdata/kiten-field/${name}`, import.meta.url),
    "utf8",
  );
}

/** Голден с адресом карточки под стенд: базовый URL у него свой. */
async function expected(name: string, baseUrl: string): Promise<string> {
  return (await golden(name)).replaceAll(
    GOLDEN_CARD_URL,
    `${baseUrl}/${CARD_ID}`,
  );
}

/** Живая карточка с файлом поля; `patch` правит её под случай теста. */
async function cardWithFiles(
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

/** Чем отвечать на «МЕТОД путь»; пара вне таблицы — красный тест. */
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

/** Текст вывода так, как его напечатает точка входа. */
async function output(
  command: Command,
  argv: readonly string[],
  io: CommandIo,
): Promise<string> {
  return command.renderResult(await command.invoke(argv, io), argv);
}

/** Вызовы в порядке обращения: «МЕТОД путь». */
function calls(seen: readonly CapturedRequest[]): readonly string[] {
  return seen.map((request) => `${request.method} ${request.pathname}`);
}

describe("field set: значение уходит в поле по таблице видов", () => {
  it("mr — url без нормализации", async () => {
    const { io, baseUrl, seen, stop } = await stand({
      [`PATCH ${CARD_PATH}`]: () => cardWithFiles(),
    });
    try {
      const value =
        "https://gitlab.example.test/team/repo/-/merge_requests/999";
      expect(
        await output(kitenFieldSetCommand, [SELECTOR, "mr", value], io),
      ).toStrictEqual(await expected("ok-set-mr-stdout.txt", baseUrl));
      expect(calls(seen)).toStrictEqual([`PATCH ${CARD_PATH}`]);
      expect(JSON.parse(seen[0].body)).toStrictEqual({
        properties: { id_398965: value },
      });
    } finally {
      await stop();
    }
  });

  it("hypothesis — текст с двоеточием внутри", async () => {
    const { io, baseUrl, seen, stop } = await stand({
      [`PATCH ${CARD_PATH}`]: () => cardWithFiles(),
    });
    try {
      const value = "Гипотеза: расход растёт из-за повтора запроса";
      expect(
        await output(kitenFieldSetCommand, [SELECTOR, "hypothesis", value], io),
      ).toStrictEqual(await expected("ok-set-hypothesis-stdout.txt", baseUrl));
      expect(JSON.parse(seen[0].body)).toStrictEqual({
        properties: { id_291984: value },
      });
    } finally {
      await stop();
    }
  });

  it("пустое значение — очистка полем null", async () => {
    const { io, baseUrl, seen, stop } = await stand({
      [`PATCH ${CARD_PATH}`]: () => cardWithFiles(),
    });
    try {
      expect(
        await output(kitenFieldSetCommand, [SELECTOR, "result", ""], io),
      ).toStrictEqual(`ok: result → — · ${baseUrl}/${CARD_ID}\n`);
      expect(JSON.parse(seen[0].body)).toStrictEqual({
        properties: { id_291990: null },
      });
    } finally {
      await stop();
    }
  });

  it("значение из одних пробелов — не очистка", async () => {
    const { io, baseUrl, seen, stop } = await stand({
      [`PATCH ${CARD_PATH}`]: () => cardWithFiles(),
    });
    try {
      expect(
        await output(kitenFieldSetCommand, [SELECTOR, "done", " \t"], io),
      ).toStrictEqual(`ok: done →  \t · ${baseUrl}/${CARD_ID}\n`);
      expect(JSON.parse(seen[0].body)).toStrictEqual({
        properties: { id_291985: " \t" },
      });
    } finally {
      await stop();
    }
  });

  it("done и result — свои id полей", async () => {
    for (const [kind, id] of [
      ["done", 291985],
      ["result", 291990],
    ] as const) {
      const { io, seen, stop } = await stand({
        [`PATCH ${CARD_PATH}`]: () => cardWithFiles(),
      });
      try {
        await output(kitenFieldSetCommand, [SELECTOR, kind, "x"], io);
        expect(JSON.parse(seen[0].body)).toStrictEqual({
          properties: { [`id_${id}`]: "x" },
        });
      } finally {
        await stop();
      }
    }
  });
});

describe("field set: ошибки ввода — до сети", () => {
  it("KIND вне закрытого списка", async () => {
    const { seen, stop } = await stand({});
    try {
      const err = assertThrowsUsage(() =>
        kitenFieldSetCommand.parseArgs([SELECTOR, "badkind", "x"]),
      );
      expect(err.message.includes("mr, hypothesis, done, result")).toBe(true);
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });

  it("селектор без числового сегмента", async () => {
    const { io, seen, stop } = await stand({});
    try {
      await expect(
        output(kitenFieldSetCommand, ["board/abc", "mr", "x"], io),
      ).rejects.toThrow(UsageError);
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });
});

it("field set: отказ API — exit 1 с полным путём команды", async () => {
  const { io, seen, stop } = await stand({
    [`PATCH ${CARD_PATH}`]: () => new Response("", { status: 403 }),
  });
  try {
    const err = await rejected(
      () => output(kitenFieldSetCommand, [SELECTOR, "mr", "x"], io),
      DomainError,
    );
    expect(
      formatCommandError("kiten field set", err).startsWith(
        "mpu kiten field set: kaiten error: ",
      ),
    ).toBe(true);
    expect(calls(seen)).toStrictEqual([`PATCH ${CARD_PATH}`]);
  } finally {
    await stop();
  }
});

describe("artefact set: файл уходит в поле 610303", () => {
  const uploaded = (name: string, url: string) => ({
    id: 62289609,
    url,
    name,
    mime_type: null,
    comment_id: null,
    card_cover: false,
    custom_property_id: 610303,
  });

  it("razbor.md — имя и url файла из ответа", async () => {
    const { io, baseUrl, seen, stop } = await stand(
      {
        [`PUT ${ARTEFACT_FILES_PATH}`]: () =>
          Response.json(
            uploaded(
              "razbor.md",
              "https://files/ec5402f3-a31f-4d18-9032-a4825cb004ba.md",
            ),
          ),
      },
      { readRegularFile: () => Promise.resolve(new Uint8Array([35, 32])) },
    );
    try {
      expect(
        await output(
          kitenArtefactSetCommand,
          [SELECTOR, "/home/user/tmp/razbor.md"],
          io,
        ),
      ).toStrictEqual(await expected("ok-artefact-set-stdout.txt", baseUrl));
      expect(calls(seen)).toStrictEqual([`PUT ${ARTEFACT_FILES_PATH}`]);
      // Прикрепляется базовое имя пути, без каталога.
      expect(seen[0].body.includes('filename="razbor.md"')).toBe(true);
    } finally {
      await stop();
    }
  });

  it("RAZBOR.MD — регистр расширения не значим", async () => {
    const { io, baseUrl, stop } = await stand(
      {
        [`PUT ${ARTEFACT_FILES_PATH}`]: () =>
          Response.json(
            uploaded(
              "RAZBOR.MD",
              "https://files/d9744f5d-7fda-458c-b529-7b6841038063.MD",
            ),
          ),
      },
      { readRegularFile: () => Promise.resolve(new Uint8Array([35])) },
    );
    try {
      expect(
        await output(kitenArtefactSetCommand, [SELECTOR, "RAZBOR.MD"], io),
      ).toStrictEqual(
        await expected("ok-artefact-set-upper-md-stdout.txt", baseUrl),
      );
    } finally {
      await stop();
    }
  });
});

describe("artefact set: ошибки ввода — до сети и до чтения", () => {
  it("имя не оканчивается на .md", async () => {
    // `readRegularFile` фейка падает на касании: проверка имени обязана
    // случиться раньше чтения файла.
    const { io, seen, stop } = await stand({});
    try {
      const err = await rejected(
        () => output(kitenArtefactSetCommand, [SELECTOR, "probe.txt"], io),
        UsageError,
      );
      expect(err.message).toStrictEqual(
        (await golden("err-not-md-message.txt")).trim(),
      );
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });

  it("селектор без числового сегмента — общий разбор", async () => {
    const { io, seen, stop } = await stand({});
    try {
      await expect(
        output(kitenArtefactRmCommand, ["board/abc"], io),
      ).rejects.toThrow(UsageError);
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });

  it("пути нет либо он не обычный файл", async () => {
    const { io, seen, stop } = await stand(
      {},
      {
        readRegularFile: () => Promise.reject(new NotFoundIoError("нет")),
      },
    );
    try {
      const err = await rejected(
        () => output(kitenArtefactSetCommand, [SELECTOR, "/nowhere/x.md"], io),
        UsageError,
      );
      expect(err.message).toBe("артефакт не найден: /nowhere/x.md");
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });
});

it("artefact set: отказ загрузки — exit 1", async () => {
  const { io, seen, stop } = await stand(
    {
      [`PUT ${ARTEFACT_FILES_PATH}`]: () => new Response("", { status: 403 }),
    },
    { readRegularFile: () => Promise.resolve(new Uint8Array([35])) },
  );
  try {
    await expect(
      output(kitenArtefactSetCommand, [SELECTOR, "razbor.md"], io),
    ).rejects.toThrow(DomainError);
    expect(calls(seen)).toStrictEqual([`PUT ${ARTEFACT_FILES_PATH}`]);
  } finally {
    await stop();
  }
});

it("artefact set: прочий отказ чтения — тоже ошибка ввода", async () => {
  const { io, seen, stop } = await stand(
    {},
    {
      readRegularFile: () => Promise.reject(new Error("permission denied")),
    },
  );
  try {
    const err = await rejected(
      () => output(kitenArtefactSetCommand, [SELECTOR, "razbor.md"], io),
      UsageError,
    );
    expect(err.message).toBe(
      "не удалось прочитать артефакт razbor.md: permission denied",
    );
    expect(calls(seen)).toStrictEqual([]);
  } finally {
    await stop();
  }
});

describe("artefact rm: удаляются только файлы поля", () => {
  it("один файл — имя в выводе, чужие не тронуты", async () => {
    const { io, baseUrl, seen, stop } = await stand({
      [`GET ${CARD_PATH}`]: () => cardWithFiles(),
      [`DELETE ${filePath(62289609)}`]: () => new Response("", { status: 200 }),
    });
    try {
      expect(
        await output(kitenArtefactRmCommand, [SELECTOR], io),
      ).toStrictEqual(await expected("ok-artefact-rm-stdout.txt", baseUrl));
      // Файлы комментариев (62289606, 62289607) не удаляются.
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `DELETE ${filePath(62289609)}`,
      ]);
    } finally {
      await stop();
    }
  });

  it("два файла — разделитель и порядок files[]", async () => {
    const second = 62289610;
    const { io, baseUrl, seen, stop } = await stand({
      [`GET ${CARD_PATH}`]: () =>
        cardWithFiles((raw) => {
          const files = raw.files as Record<string, unknown>[];
          const artefact = files[files.length - 1];
          files.splice(files.length - 1, 0, {
            ...artefact,
            id: second,
            name: "RAZBOR.MD",
          });
        }),
      [`DELETE ${filePath(second)}`]: () => new Response("", { status: 200 }),
      [`DELETE ${filePath(62289609)}`]: () => new Response("", { status: 200 }),
    });
    try {
      expect(
        await output(kitenArtefactRmCommand, [SELECTOR], io),
      ).toStrictEqual(
        await expected("ok-artefact-rm-two-files-stdout.txt", baseUrl),
      );
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `DELETE ${filePath(second)}`,
        `DELETE ${filePath(62289609)}`,
      ]);
    } finally {
      await stop();
    }
  });

  it("поле пусто — успех без единого удаления", async () => {
    const { io, baseUrl, seen, stop } = await stand({
      [`GET ${CARD_PATH}`]: () =>
        cardWithFiles((raw) => {
          const files = raw.files as Record<string, unknown>[];
          raw.files = files.filter(
            (file) => file.custom_property_id !== 610303,
          );
        }),
    });
    try {
      expect(
        await output(kitenArtefactRmCommand, [SELECTOR], io),
      ).toStrictEqual(
        await expected("ok-artefact-rm-empty-stdout.txt", baseUrl),
      );
      expect(calls(seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  it("сбой в середине: следующий файл не трогается", async () => {
    // Три файла поля, отказ на втором: третьего удаления не будет вовсе —
    // файлы удаляются по одному, а не разом (`kiten-field.md`).
    const { io, seen, stop } = await stand({
      [`GET ${CARD_PATH}`]: () => cardWithFiles(withArtefacts(3)),
      [`DELETE ${filePath(62289701)}`]: () => new Response("", { status: 200 }),
      [`DELETE ${filePath(62289702)}`]: () => new Response("", { status: 403 }),
      [`DELETE ${filePath(62289703)}`]: () => new Response("", { status: 200 }),
    });
    try {
      await expect(
        output(kitenArtefactRmCommand, [SELECTOR], io),
      ).rejects.toThrow(DomainError);
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `DELETE ${filePath(62289701)}`,
        `DELETE ${filePath(62289702)}`,
      ]);
    } finally {
      await stop();
    }
  });
});

/** Заменяет файлы поля на `count` штук с предсказуемыми id и именами. */
function withArtefacts(count: number) {
  return (raw: Record<string, unknown>) => {
    const files = raw.files as Record<string, unknown>[];
    const artefact = files[files.length - 1];
    raw.files = [
      ...files.filter((file) => file.custom_property_id !== 610303),
      ...Array.from({ length: count }, (_, index) => ({
        ...artefact,
        id: 62289701 + index,
        name: `razbor-${index + 1}.md`,
      })),
    ];
  };
}

it("ненастроенный KITEN_API_KEY — ошибка ввода, а не отказ API", async () => {
  const io = makeFakeIo({
    envFile: {
      get: () => undefined,
      values: () => ({}),
      require: () => "",
      set: () => Promise.resolve(),
    },
  });
  const cases: readonly [Command, readonly string[]][] = [
    [kitenFieldSetCommand, [SELECTOR, "mr", "x"]],
    [kitenArtefactSetCommand, [SELECTOR, "razbor.md"]],
    [kitenArtefactRmCommand, [SELECTOR]],
  ];
  for (const [command, argv] of cases) {
    await expect(command.invoke(argv, io)).rejects.toThrow(UsageError);
  }
});

/** Синхронный отказ разбора argv: схема команды бракует KIND. */
function assertThrowsUsage(call: () => unknown): UsageError {
  try {
    call();
  } catch (err) {
    if (err instanceof UsageError) return err;
    throw err;
  }
  throw new Error("ожидалась UsageError, а вызов прошёл");
}
