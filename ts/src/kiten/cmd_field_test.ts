/**
 * Команды `mpu kiten field` (`docs/specs/kiten-field.md`). Выводы всех
 * успешных ветвей закрыты голденами канала, снятыми живым прогоном; вход
 * ветвей `artefact rm` — живой ответ карточки с файлом поля
 * (`raw-card-file-property.json`), потому что привязку к полю показывает
 * именно он.
 *
 * Вызов идёт от argv, как из точки входа, а каталог ходит в фейковый
 * Kaiten на петле (`../kaiten/testing.ts`): так под проверку попадает и
 * состав запросов — какие ушли, в каком порядке и чего в них нет.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  type CommandIo,
  DomainError,
  formatCommandError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
import {
  kitenArtefactRmCommand,
  kitenArtefactSetCommand,
  kitenFieldSetCommand,
} from "./mod.ts";
import type { Command } from "../command/mod.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";
const CARD_ID = 10000001;
const SELECTOR = String(CARD_ID);

const CARD_PATH = `/api/latest/cards/${CARD_ID}`;
const ARTEFACT_FILES_PATH = `${CARD_PATH}/custom-properties/610303/files`;
const filePath = (fileId: number) => `${CARD_PATH}/files/${fileId}`;

/** Адрес карточки в голденах: снят с обезличенного живого прогона. */
const GOLDEN_CARD_URL = `https://kaiten.example.test/${CARD_ID}`;

function golden(name: string): Promise<string> {
  return Deno.readTextFile(
    new URL(`testdata/kiten-field/${name}`, import.meta.url),
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

/** Чем отвечать на «МЕТОД путь»; пара вне таблицы — красный тест. */
type Routes = Readonly<
  Record<string, () => Response | Promise<Response>>
>;

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

Deno.test("field set: значение уходит в поле по таблице видов", async (t) => {
  await t.step("mr — url без нормализации", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [`PATCH ${CARD_PATH}`]: () => cardWithFiles(),
    });
    try {
      const value =
        "https://gitlab.example.test/team/repo/-/merge_requests/999";
      assertEquals(
        await output(kitenFieldSetCommand, [SELECTOR, "mr", value], io),
        await expected("ok-set-mr-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [`PATCH ${CARD_PATH}`]);
      assertEquals(
        JSON.parse(seen[0].body),
        { properties: { id_398965: value } },
      );
    } finally {
      await stop();
    }
  });

  await t.step("hypothesis — текст с двоеточием внутри", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [`PATCH ${CARD_PATH}`]: () => cardWithFiles(),
    });
    try {
      const value = "Гипотеза: расход растёт из-за повтора запроса";
      assertEquals(
        await output(
          kitenFieldSetCommand,
          [SELECTOR, "hypothesis", value],
          io,
        ),
        await expected("ok-set-hypothesis-stdout.txt", baseUrl),
      );
      assertEquals(
        JSON.parse(seen[0].body),
        { properties: { id_291984: value } },
      );
    } finally {
      await stop();
    }
  });

  await t.step("done и result — свои id полей", async () => {
    for (const [kind, id] of [["done", 291985], ["result", 291990]] as const) {
      const { io, seen, stop } = stand({
        [`PATCH ${CARD_PATH}`]: () => cardWithFiles(),
      });
      try {
        await output(kitenFieldSetCommand, [SELECTOR, kind, "x"], io);
        assertEquals(JSON.parse(seen[0].body), {
          properties: { [`id_${id}`]: "x" },
        });
      } finally {
        await stop();
      }
    }
  });
});

Deno.test("field set: ошибки ввода — до сети", async (t) => {
  await t.step("KIND вне закрытого списка", async () => {
    const { seen, stop } = stand({});
    try {
      const err = assertThrowsUsage(() =>
        kitenFieldSetCommand.parseArgs([SELECTOR, "badkind", "x"])
      );
      assertEquals(err.message.includes("mr, hypothesis, done, result"), true);
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("селектор без числового сегмента", async () => {
    const { io, seen, stop } = stand({});
    try {
      await assertRejects(
        () => output(kitenFieldSetCommand, ["board/abc", "mr", "x"], io),
        UsageError,
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });
});

Deno.test("field set: отказ API — exit 1 с полным путём команды", async () => {
  const { io, seen, stop } = stand({
    [`PATCH ${CARD_PATH}`]: () => new Response("", { status: 403 }),
  });
  try {
    const err = await assertRejects(
      () => output(kitenFieldSetCommand, [SELECTOR, "mr", "x"], io),
      DomainError,
    );
    assertEquals(
      formatCommandError("kiten field set", err).startsWith(
        "mpu kiten field set: kaiten error: ",
      ),
      true,
    );
    assertEquals(calls(seen), [`PATCH ${CARD_PATH}`]);
  } finally {
    await stop();
  }
});

Deno.test("artefact set: файл уходит в поле 610303", async (t) => {
  const uploaded = (name: string, url: string) => ({
    id: 62289609,
    url,
    name,
    mime_type: null,
    comment_id: null,
    card_cover: false,
    custom_property_id: 610303,
  });

  await t.step("razbor.md — имя и url файла из ответа", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [`PUT ${ARTEFACT_FILES_PATH}`]: () =>
        Response.json(uploaded(
          "razbor.md",
          "https://files/ec5402f3-a31f-4d18-9032-a4825cb004ba.md",
        )),
    }, { readRegularFile: () => Promise.resolve(new Uint8Array([35, 32])) });
    try {
      assertEquals(
        await output(
          kitenArtefactSetCommand,
          [SELECTOR, "/home/user/tmp/razbor.md"],
          io,
        ),
        await expected("ok-artefact-set-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [`PUT ${ARTEFACT_FILES_PATH}`]);
      // Прикрепляется базовое имя пути, без каталога.
      assertEquals(seen[0].body.includes('filename="razbor.md"'), true);
    } finally {
      await stop();
    }
  });

  await t.step("RAZBOR.MD — регистр расширения не значим", async () => {
    const { io, baseUrl, stop } = stand({
      [`PUT ${ARTEFACT_FILES_PATH}`]: () =>
        Response.json(uploaded(
          "RAZBOR.MD",
          "https://files/d9744f5d-7fda-458c-b529-7b6841038063.MD",
        )),
    }, { readRegularFile: () => Promise.resolve(new Uint8Array([35])) });
    try {
      assertEquals(
        await output(kitenArtefactSetCommand, [SELECTOR, "RAZBOR.MD"], io),
        await expected("ok-artefact-set-upper-md-stdout.txt", baseUrl),
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("artefact set: ошибки ввода — до сети и до чтения", async (t) => {
  await t.step("имя не оканчивается на .md", async () => {
    // `readRegularFile` фейка падает на касании: проверка имени обязана
    // случиться раньше чтения файла.
    const { io, seen, stop } = stand({});
    try {
      const err = await assertRejects(
        () => output(kitenArtefactSetCommand, [SELECTOR, "probe.txt"], io),
        UsageError,
      );
      assertEquals(
        err.message,
        (await golden("err-not-md-message.txt")).trim(),
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("селектор без числового сегмента — общий разбор", async () => {
    const { io, seen, stop } = stand({});
    try {
      await assertRejects(
        () => output(kitenArtefactRmCommand, ["board/abc"], io),
        UsageError,
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("пути нет либо он не обычный файл", async () => {
    const { io, seen, stop } = stand({}, {
      readRegularFile: () => Promise.reject(new NotFoundIoError("нет")),
    });
    try {
      const err = await assertRejects(
        () => output(kitenArtefactSetCommand, [SELECTOR, "/nowhere/x.md"], io),
        UsageError,
      );
      assertEquals(err.message, "артефакт не найден: /nowhere/x.md");
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });
});

Deno.test("artefact set: отказ загрузки — exit 1", async () => {
  const { io, seen, stop } = stand({
    [`PUT ${ARTEFACT_FILES_PATH}`]: () => new Response("", { status: 403 }),
  }, { readRegularFile: () => Promise.resolve(new Uint8Array([35])) });
  try {
    await assertRejects(
      () => output(kitenArtefactSetCommand, [SELECTOR, "razbor.md"], io),
      DomainError,
    );
    assertEquals(calls(seen), [`PUT ${ARTEFACT_FILES_PATH}`]);
  } finally {
    await stop();
  }
});

Deno.test("artefact set: прочий отказ чтения — тоже ошибка ввода", async () => {
  const { io, seen, stop } = stand({}, {
    readRegularFile: () => Promise.reject(new Error("permission denied")),
  });
  try {
    const err = await assertRejects(
      () => output(kitenArtefactSetCommand, [SELECTOR, "razbor.md"], io),
      UsageError,
    );
    assertEquals(
      err.message,
      "не удалось прочитать артефакт razbor.md: permission denied",
    );
    assertEquals(calls(seen), []);
  } finally {
    await stop();
  }
});

Deno.test("artefact rm: удаляются только файлы поля", async (t) => {
  await t.step("один файл — имя в выводе, чужие не тронуты", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () => cardWithFiles(),
      [`DELETE ${filePath(62289609)}`]: () => new Response("", { status: 200 }),
    });
    try {
      assertEquals(
        await output(kitenArtefactRmCommand, [SELECTOR], io),
        await expected("ok-artefact-rm-stdout.txt", baseUrl),
      );
      // Файлы комментариев (62289606, 62289607) не удаляются.
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `DELETE ${filePath(62289609)}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("два файла — разделитель и порядок files[]", async () => {
    const second = 62289610;
    const { io, baseUrl, seen, stop } = stand({
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
      assertEquals(
        await output(kitenArtefactRmCommand, [SELECTOR], io),
        await expected("ok-artefact-rm-two-files-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `DELETE ${filePath(second)}`,
        `DELETE ${filePath(62289609)}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("поле пусто — успех без единого удаления", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        cardWithFiles((raw) => {
          const files = raw.files as Record<string, unknown>[];
          raw.files = files.filter((file) =>
            file.custom_property_id !== 610303
          );
        }),
    });
    try {
      assertEquals(
        await output(kitenArtefactRmCommand, [SELECTOR], io),
        await expected("ok-artefact-rm-empty-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  await t.step("сбой в середине: следующий файл не трогается", async () => {
    // Три файла поля, отказ на втором: третьего удаления не будет вовсе —
    // файлы удаляются по одному, а не разом (`kiten-field.md`).
    const { io, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () => cardWithFiles(withArtefacts(3)),
      [`DELETE ${filePath(62289701)}`]: () => new Response("", { status: 200 }),
      [`DELETE ${filePath(62289702)}`]: () => new Response("", { status: 403 }),
      [`DELETE ${filePath(62289703)}`]: () => new Response("", { status: 200 }),
    });
    try {
      await assertRejects(
        () => output(kitenArtefactRmCommand, [SELECTOR], io),
        DomainError,
      );
      assertEquals(calls(seen), [
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

Deno.test("ненастроенный KITEN_API_KEY — ошибка ввода, а не отказ API", async () => {
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
    await assertRejects(() => command.invoke(argv, io), UsageError);
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
