/**
 * Команды `mpu api` (`docs/specs/api.md`): форма запроса, печать
 * ответа и отказы. Стенд настоящий, на петле — проверяется то, что
 * ушло по сети и что напечаталось, а не намерения кода.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { type Command, DomainError, UsageError } from "@mpu/command";
import { makeFakeIo } from "@mpu/command/testing";
import {
  type CapturedRequest,
  loginReply,
  startFakeSlback,
} from "@mpu/slback/testing";
import { apiCommands } from "../index.ts";
import { PATH_ARG_HELP, pathParams } from "./endpoint.ts";
import { READ_ENDPOINTS } from "./endpoints.ts";

const TOKEN = "jwt-proba-9f2";

function commandOf(name: string): Command {
  const found = apiCommands.find((command) => command.path[1] === name);
  if (found === undefined) throw new Error(`нет команды api ${name}`);
  return found;
}

/** Порт с адресом стенда, кредами и приёмником токен-кэша. */
function ioTo(
  baseUrl: string,
  opts: {
    cache?: string;
    written?: string[];
    files?: Record<string, string>;
  } = {},
) {
  let cache = opts.cache;
  const values: Record<string, string> = {
    BASE_API_URL: baseUrl,
    TOKEN_EMAIL: "kto@test",
    TOKEN_PASSWORD: "parol",
  };
  return makeFakeIo({
    readTextFile: (path) => {
      const text = opts.files?.[path];
      return text === undefined
        ? Promise.reject(new Error("file not found"))
        : Promise.resolve(text);
    },
    // Кэш живёт в памяти порта: команда, вызванная дважды, логинится
    // один раз — как оно и есть у живого файла.
    readTokenCache: () => Promise.resolve(cache),
    writeTokenCache: (text) => {
      cache = text;
      opts.written?.push(text);
      return Promise.resolve();
    },
    envFile: {
      get: (name: string) => values[name],
      require: () => {
        throw new Error("require не ожидается");
      },
      set: () => Promise.reject(new Error("set не ожидается")),
      values: () => ({ ...values }),
    },
  });
}

/** Стенд, отвечающий логином на первый вызов и `body` — на второй. */
function standWith(body: (seen: readonly CapturedRequest[]) => Response) {
  return startFakeSlback((seen) =>
    seen.length === 1 ? loginReply(TOKEN) : body(seen),
  );
}

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/api/${name}`, import.meta.url),
    "utf8",
  );
}

/** Запуск команды до текста: тем же путём, что и точка входа. */
async function run(
  command: Command,
  argv: readonly string[],
  io: ReturnType<typeof makeFakeIo>,
): Promise<string> {
  return command.renderResult(await command.invoke(argv, io), argv);
}

it("get-client печатает ответ сервера побайтно как голден", async () => {
  const compact = JSON.stringify(JSON.parse(await golden("get-client.json")));
  const stand = await standWith(
    () =>
      new Response(compact, {
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const text = await run(
      commandOf("get-client"),
      ["777"],
      ioTo(stand.baseUrl),
    );
    expect(text).toStrictEqual(await golden("get-client.json"));
    expect(stand.seen[1].pathname).toBe("/admin/client/777");
    expect(stand.seen[1].method).toBe("GET");
  } finally {
    await stand.stop();
  }
});

it("list-client-modules печатает массив как есть", async () => {
  const compact = JSON.stringify(
    JSON.parse(await golden("list-client-modules.json")),
  );
  const stand = await standWith(() => new Response(compact));
  try {
    const text = await run(
      commandOf("list-client-modules"),
      ["777"],
      ioTo(stand.baseUrl),
    );
    expect(text).toStrictEqual(await golden("list-client-modules.json"));
    expect(stand.seen[1].pathname).toBe("/admin/client/777/modules");
  } finally {
    await stand.stop();
  }
});

it("порядок ключей ответа не меняется", async () => {
  // Ключи нарочно не по алфавиту: сортировка вылезла бы здесь.
  const stand = await standWith(() => new Response('{"я":1,"a":2,"b":3}'));
  try {
    const text = await run(commandOf("list-roles"), [], ioTo(stand.baseUrl));
    expect(text).toBe('{\n  "я": 1,\n  "a": 2,\n  "b": 3\n}\n');
  } finally {
    await stand.stop();
  }
});

it("пустой ответ — пустой stdout", async () => {
  const stand = await standWith(() => new Response(null, { status: 204 }));
  try {
    expect(await run(commandOf("list-roles"), [], ioTo(stand.baseUrl))).toBe(
      "",
    );
  } finally {
    await stand.stop();
  }
});

it("идентификатор в пути экранируется, а не склеивается", async () => {
  const stand = await standWith(() => new Response("{}"));
  try {
    await run(
      commandOf("get-client-ss-dataset"),
      ["777", "1BxiMVs0", "Лист/1"],
      ioTo(stand.baseUrl),
    );
    expect(stand.seen[1].pathname).toBe(
      "/admin/client/777/ss/1BxiMVs0/dataset/%D0%9B%D0%B8%D1%81%D1%82%2F1",
    );
  } finally {
    await stand.stop();
  }
});

it("HTTP ≥ 400 — отказ команды, тело отдельной строкой", async () => {
  const stand = await standWith(
    () => new Response('{"message":"client not found"}', { status: 404 }),
  );
  try {
    const err = await rejected(
      () => commandOf("get-client").invoke(["404"], ioTo(stand.baseUrl)),
      DomainError,
    );
    expect(err.message).toBe("GET /admin/client/404 failed: HTTP 404");
    expect(err.details).toBe('{"message":"client not found"}');
  } finally {
    await stand.stop();
  }
});

it("500 не превращается в успех", async () => {
  const stand = await standWith(() => new Response("", { status: 500 }));
  try {
    const err = await rejected(
      () => commandOf("list-clients").invoke([], ioTo(stand.baseUrl)),
      DomainError,
    );
    expect(err.message).toBe("GET /admin/client failed: HTTP 500");
    // Тела нет — лишней пустой строки под ошибкой тоже нет.
    expect(err.details).toStrictEqual(undefined);
  } finally {
    await stand.stop();
  }
});

it("токена нет в тексте отказа, хотя он ушёл заголовком", async () => {
  const stand = await standWith(
    () => new Response("нет доступа", { status: 403 }),
  );
  try {
    const err = await rejected(
      () => commandOf("list-users").invoke([], ioTo(stand.baseUrl)),
      DomainError,
    );
    // Токен ушёл на сервер — и это единственное место, где он бывает.
    expect(stand.seen[1].authorization).toStrictEqual(`Bearer ${TOKEN}`);
    expect(`${err.message}\n${err.details ?? ""}`).not.toMatch(
      new RegExp(TOKEN),
    );
  } finally {
    await stand.stop();
  }
});

it("токена нет в выводе, даже когда сервер вернул его телом", async () => {
  // Сервер вправе прислать что угодно; наше дело — напечатать ответ как
  // есть и не добавить к нему своего токена. Тело нарочно содержит
  // токен: проверка, что печать не «примерно та же», а именно ответ.
  const body = JSON.stringify([{ token: `${TOKEN}-чужой` }]);
  const stand = await standWith(() => new Response(body));
  try {
    const text = await run(
      commandOf("list-client-wb-tokens"),
      ["777"],
      ioTo(stand.baseUrl),
    );
    expect(text).toStrictEqual(
      `${JSON.stringify(JSON.parse(body), null, 2)}\n`,
    );
    expect(text.includes(`Bearer ${TOKEN}`)).toBe(false);
  } finally {
    await stand.stop();
  }
});

it("сегмент пути '..' отбивается до сети", async () => {
  const stand = await standWith(
    () => new Response("не ожидается", { status: 500 }),
  );
  try {
    for (const value of [".", ".."]) {
      const err = await rejected(
        () => commandOf("get-client").invoke([value], ioTo(stand.baseUrl)),
        UsageError,
      );
      expect(err.message).toStrictEqual(
        `userId: '${value}' — не идентификатор, а сегмент пути`,
      );
    }
    expect(stand.seen.length).toBe(0);
  } finally {
    await stand.stop();
  }
});

it("ответ с секретами и персональными данными в журнал не пишется", () => {
  // Пометка живёт в строке таблицы, поэтому проверяется по таблице:
  // список имён рядом с ней разошёлся бы с ней же. Состав закрыт: у
  // двух команд в ответе чужие ключи, у двух — почта пользователя и
  // ссылка активации (замеры спецификатора на живом клиенте).
  const secret = READ_ENDPOINTS.filter(
    (endpoint) => endpoint.sensitiveOutput === true,
  ).map((endpoint) => endpoint.name);
  expect(secret).toStrictEqual([
    "get-user",
    "list-client-ozon-keys",
    "list-client-wb-tokens",
    "list-users",
  ]);
  for (const endpoint of READ_ENDPOINTS) {
    expect(
      commandOf(endpoint.name).logsOutput,
      `api ${endpoint.name}: пометка журнала разошлась с таблицей`,
    ).toStrictEqual(!secret.includes(endpoint.name));
  }
  // `get-token` в таблице не объявлен: он кастомный, и вывод у него
  // скрыт своей причиной — живым токеном sl-back.
  expect(commandOf("get-token").logsOutput).toBe(false);
});

it("обязательность поля видна в справке команды", () => {
  // Отказ `--X обязателен` приходит уже при разборе ввода, а до него
  // пользователь читает справку: если обязательность не названа там,
  // единственный способ её узнать — получить отказ. Проверяется на
  // смешанной команде, чтобы пометка не оказалась приклеена ко всем
  // полям подряд.
  //
  // У `cli-run` есть `--body`, поэтому обязательность условна, и текст
  // называет условие: тело замещает поля целиком.
  const fields = commandOf("cli-run").argsJsonSchema.properties;
  for (const name of ["server", "name", "method"]) {
    expect(
      fields[name].description ?? "",
      `${name}: обязательность не названа в справке`,
    ).toContain("(required, если не задан body: или body-file:)");
  }
  for (const name of ["args", "requestId"]) {
    expect(
      (fields[name].description ?? "").includes("(required)"),
      `${name}: необязательное поле названо обязательным`,
    ).toBe(false);
  }
});

describe("нехватка обязательного поля печатается одинаково с обеих сторон", () => {
  // Отказ приходит из двух мест: у команды без `--body` его бросает
  // схема, у команды с `--body` — разбор полей. Текст и подсказка
  // обязаны совпадать: одна и та же нехватка не может выглядеть
  // по-разному от того, какой слой её заметил.
  const cases: readonly [string, readonly string[], string][] = [
    ["auth-login", ["--email", "a@b.c"], "--password обязателен"],
    ["cli-run", ["--server", "s"], "--name обязателен"],
  ];
  for (const [name, argv, message] of cases) {
    it(name, async () => {
      const command = commandOf(name);
      const err = await rejected(
        () => command.invoke(argv, makeFakeIo()),
        UsageError,
      );
      expect(err.message).toContain(message);
      expect(
        (err as UsageError).hint,
        `${name}: подсказка отличается`,
      ).toStrictEqual(`mpu api ${name} --help`);
    });
  }
});

it("у каждого path-параметра таблицы есть пояснение", () => {
  // Пояснение необязательно по построению (иначе новый эндпоинт стоил
  // бы двух правок), поэтому полноту стережёт тест: без него справка
  // молча выродилась бы в «clientId: clientId».
  for (const endpoint of READ_ENDPOINTS) {
    for (const name of pathParams(endpoint.path)) {
      expect(
        typeof PATH_ARG_HELP[name],
        `нет пояснения к :${name} (эндпоинт ${endpoint.name})`,
      ).toBe("string");
    }
  }
});

it("поля тела собираются в JSON, --body замещает их целиком", async () => {
  const stand = await standWith(() => new Response("[]"));
  try {
    const command = commandOf("get-ss-values");
    const io = ioTo(stand.baseUrl, {
      files: { "/тело.json": '{"range":"Z9"}' },
    });
    await run(
      command,
      ["ss1", "--range", "A1:B2", "--majorDimension", "COLUMNS"],
      io,
    );
    expect(stand.seen[1].method).toBe("POST");
    expect(stand.seen[1].pathname).toBe("/admin/ss/ss1/values");
    expect(stand.seen[1].contentType).toBe("application/json");
    expect(JSON.parse(stand.seen[1].body)).toStrictEqual({
      range: "A1:B2",
      majorDimension: "COLUMNS",
    });

    await run(command, ["ss1", "--range", "A1:B2", "-b", '{"range":"C3"}'], io);
    expect(JSON.parse(stand.seen[2].body)).toStrictEqual({ range: "C3" });

    await run(command, ["ss1", "--body-file", "/тело.json"], io);
    expect(JSON.parse(stand.seen[3].body)).toStrictEqual({ range: "Z9" });
  } finally {
    await stand.stop();
  }
});

it("ошибки ввода отбиваются до сети", async () => {
  const stand = await standWith(
    () => new Response("не ожидается", { status: 500 }),
  );
  try {
    const command = commandOf("get-ss-values");
    const io = ioTo(stand.baseUrl);
    const missing = await rejected(
      () => command.invoke(["ss1"], io),
      UsageError,
    );
    expect(missing.message).toBe("--range обязателен");
    const badBody = await rejected(
      () => command.invoke(["ss1", "-b", "{нет"], io),
      UsageError,
    );
    expect(badBody.message).toContain("--body: невалидный JSON: ");
    const noFile = await rejected(
      () => command.invoke(["ss1", "--body-file", "/нет.json"], io),
      UsageError,
    );
    expect(noFile.message).toBe("body-file: /нет.json: file not found");
    const both = await rejected(
      () => command.invoke(["ss1", "-b", "{}", "--body-file", "/нет.json"], io),
      UsageError,
    );
    expect(both.message).toBe("body: и body-file: вместе нельзя — тело одно");
    // Ни один из отказов не стоил обращения наружу.
    expect(stand.seen.length).toBe(0);
  } finally {
    await stand.stop();
  }
});

it("get-token: живой кэш печатается без сети", async () => {
  const stand = await standWith(
    () => new Response("не ожидается", { status: 500 }),
  );
  try {
    const cache = JSON.stringify({
      token: "из-кэша",
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });
    const text = await run(
      commandOf("get-token"),
      [],
      ioTo(stand.baseUrl, { cache }),
    );
    expect(text).toBe("из-кэша\n");
    expect(stand.seen.length).toBe(0);
  } finally {
    await stand.stop();
  }
});

it("get-token: оба флага — свежий логин мимо живого кэша", async () => {
  const stand = await startFakeSlback(() => loginReply("новый"));
  const written: string[] = [];
  try {
    const cache = JSON.stringify({
      token: "из-кэша",
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });
    const text = await run(
      commandOf("get-token"),
      ["--email", "drugoy@test", "--password", "tajna"],
      ioTo(stand.baseUrl, { cache, written }),
    );
    expect(text).toBe("новый\n");
    expect(JSON.parse(stand.seen[0].body)).toStrictEqual({
      email: "drugoy@test",
      password: "tajna",
    });
    expect(JSON.parse(written[0]).token).toBe("новый");
  } finally {
    await stand.stop();
  }
});

it("get-token: один флаг — кэш по-прежнему старше сети", async () => {
  const stand = await startFakeSlback(
    () => new Response("не ожидается", { status: 500 }),
  );
  try {
    const cache = JSON.stringify({
      token: "из-кэша",
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });
    const text = await run(
      commandOf("get-token"),
      ["--email", "drugoy@test"],
      ioTo(stand.baseUrl, { cache }),
    );
    expect(text).toBe("из-кэша\n");
    expect(stand.seen.length).toBe(0);
  } finally {
    await stand.stop();
  }
});

it("get-token: ответ логина без accessToken — свой текст отказа", async () => {
  const stand = await startFakeSlback(() => Response.json({ user: { id: 1 } }));
  try {
    const err = await rejected(
      () => commandOf("get-token").invoke([], ioTo(stand.baseUrl)),
      DomainError,
    );
    expect(err.message).toBe("нет accessToken в ответе sl-back");
  } finally {
    await stand.stop();
  }
});

it("get-token не пишет в журнал ни ввода, ни вывода", () => {
  const command = commandOf("get-token");
  expect(command.logsArguments).toBe(false);
  expect(command.logsOutput).toBe(false);
});

it("таблица даёт 101 команду с однострокой «метод + путь»", () => {
  // 22 читающих, 68 остатка (`api-write.md`) и одиннадцать кастомных:
  // четыре `ss-access`, `wb-cards-reset` и шесть `wb-loader-*`.
  // Неймспейс переехал целиком.
  expect(apiCommands.length).toBe(101);
  const names = apiCommands.map((command) => command.path[1]);
  // Имя второго сегмента у `ss-access` общее на четыре команды —
  // уникальны пути целиком, а не вторые сегменты.
  const paths = apiCommands.map((command) => command.path.join(" "));
  expect(new Set(paths).size).toStrictEqual(paths.length);
  expect([...names].sort()).toStrictEqual(names);
  expect(commandOf("get-client").summary).toBe("GET /admin/client/:userId");
  expect(commandOf("list-wb-cabinets").summary).toBe("GET /admin/wb-cabinets");
  expect(commandOf("create-client").summary).toBe("POST /admin/client");
  for (const command of apiCommands) {
    // Рамка ошибки — полный путь: у трёхуровневых `ss-access` второго
    // сегмента для этого мало.
    expect(command.errorName).toStrictEqual(command.path.join(" "));
  }
  // Политика следует методу, а не таблице: читающая команда остатка
  // (`auth-verify`) объявлена `ro`, как и вся читающая половина.
  expect(commandOf("get-client").policy).toBe("ro");
  expect(commandOf("auth-verify").policy).toBe("ro");
  expect(commandOf("create-client").policy).toBe("rw");
  expect(commandOf("delete-client").policy).toBe("rw");
});
