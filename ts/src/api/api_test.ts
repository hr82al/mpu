/**
 * Команды `mpu api` (`docs/specs/api.md`): форма запроса, печать
 * ответа и отказы. Стенд настоящий, на петле — проверяется то, что
 * ушло по сети и что напечаталось, а не намерения кода.
 */

import {
  assertEquals,
  assertNotMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { type Command, DomainError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  type CapturedRequest,
  loginReply,
  startFakeSlback,
} from "../slback/testing.ts";
import { apiCommands } from "./mod.ts";
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
  opts: { cache?: string; written?: string[]; files?: Record<string, string> } =
    {},
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
    seen.length === 1 ? loginReply(TOKEN) : body(seen)
  );
}

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/api/${name}`, import.meta.url),
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

Deno.test("get-client печатает ответ сервера побайтно как голден", async () => {
  const compact = JSON.stringify(JSON.parse(await golden("get-client.json")));
  const stand = standWith(() =>
    new Response(compact, { headers: { "content-type": "application/json" } })
  );
  try {
    const text = await run(
      commandOf("get-client"),
      ["777"],
      ioTo(stand.baseUrl),
    );
    assertEquals(text, await golden("get-client.json"));
    assertEquals(stand.seen[1].pathname, "/admin/client/777");
    assertEquals(stand.seen[1].method, "GET");
  } finally {
    await stand.stop();
  }
});

Deno.test("list-client-modules печатает массив как есть", async () => {
  const compact = JSON.stringify(
    JSON.parse(await golden("list-client-modules.json")),
  );
  const stand = standWith(() => new Response(compact));
  try {
    const text = await run(
      commandOf("list-client-modules"),
      ["777"],
      ioTo(stand.baseUrl),
    );
    assertEquals(text, await golden("list-client-modules.json"));
    assertEquals(stand.seen[1].pathname, "/admin/client/777/modules");
  } finally {
    await stand.stop();
  }
});

Deno.test("порядок ключей ответа не меняется", async () => {
  // Ключи нарочно не по алфавиту: сортировка вылезла бы здесь.
  const stand = standWith(() => new Response('{"я":1,"a":2,"b":3}'));
  try {
    const text = await run(commandOf("list-roles"), [], ioTo(stand.baseUrl));
    assertEquals(text, '{\n  "я": 1,\n  "a": 2,\n  "b": 3\n}\n');
  } finally {
    await stand.stop();
  }
});

Deno.test("пустой ответ — пустой stdout", async () => {
  const stand = standWith(() => new Response(null, { status: 204 }));
  try {
    assertEquals(
      await run(commandOf("list-roles"), [], ioTo(stand.baseUrl)),
      "",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("идентификатор в пути экранируется, а не склеивается", async () => {
  const stand = standWith(() => new Response("{}"));
  try {
    await run(
      commandOf("get-client-ss-dataset"),
      ["777", "1BxiMVs0", "Лист/1"],
      ioTo(stand.baseUrl),
    );
    assertEquals(
      stand.seen[1].pathname,
      "/admin/client/777/ss/1BxiMVs0/dataset/%D0%9B%D0%B8%D1%81%D1%82%2F1",
    );
  } finally {
    await stand.stop();
  }
});

Deno.test("HTTP ≥ 400 — отказ команды, тело отдельной строкой", async () => {
  const stand = standWith(() =>
    new Response('{"message":"client not found"}', { status: 404 })
  );
  try {
    const err = await assertRejects(
      () => commandOf("get-client").invoke(["404"], ioTo(stand.baseUrl)),
      DomainError,
    );
    assertEquals(err.message, "GET /admin/client/404 failed: HTTP 404");
    assertEquals(err.details, '{"message":"client not found"}');
  } finally {
    await stand.stop();
  }
});

Deno.test("500 не превращается в успех", async () => {
  const stand = standWith(() => new Response("", { status: 500 }));
  try {
    const err = await assertRejects(
      () => commandOf("list-clients").invoke([], ioTo(stand.baseUrl)),
      DomainError,
    );
    assertEquals(err.message, "GET /admin/client failed: HTTP 500");
    // Тела нет — лишней пустой строки под ошибкой тоже нет.
    assertEquals(err.details, undefined);
  } finally {
    await stand.stop();
  }
});

Deno.test("токена нет в тексте отказа, хотя он ушёл заголовком", async () => {
  const stand = standWith(() => new Response("нет доступа", { status: 403 }));
  try {
    const err = await assertRejects(
      () => commandOf("list-users").invoke([], ioTo(stand.baseUrl)),
      DomainError,
    );
    // Токен ушёл на сервер — и это единственное место, где он бывает.
    assertEquals(stand.seen[1].authorization, `Bearer ${TOKEN}`);
    assertNotMatch(`${err.message}\n${err.details ?? ""}`, new RegExp(TOKEN));
  } finally {
    await stand.stop();
  }
});

Deno.test("токена нет в выводе, даже когда сервер вернул его телом", async () => {
  // Сервер вправе прислать что угодно; наше дело — напечатать ответ как
  // есть и не добавить к нему своего токена. Тело нарочно содержит
  // токен: проверка, что печать не «примерно та же», а именно ответ.
  const body = JSON.stringify([{ token: `${TOKEN}-чужой` }]);
  const stand = standWith(() => new Response(body));
  try {
    const text = await run(
      commandOf("list-client-wb-tokens"),
      ["777"],
      ioTo(stand.baseUrl),
    );
    assertEquals(text, `${JSON.stringify(JSON.parse(body), null, 2)}\n`);
    assertEquals(text.includes(`Bearer ${TOKEN}`), false);
  } finally {
    await stand.stop();
  }
});

Deno.test("сегмент пути '..' отбивается до сети", async () => {
  const stand = standWith(() => new Response("не ожидается", { status: 500 }));
  try {
    for (const value of [".", ".."]) {
      const err = await assertRejects(
        () => commandOf("get-client").invoke([value], ioTo(stand.baseUrl)),
        UsageError,
      );
      assertEquals(
        err.message,
        `userId: '${value}' — не идентификатор, а сегмент пути`,
      );
    }
    assertEquals(stand.seen.length, 0);
  } finally {
    await stand.stop();
  }
});

Deno.test("ответ с секретами и персональными данными в журнал не пишется", () => {
  // Пометка живёт в строке таблицы, поэтому проверяется по таблице:
  // список имён рядом с ней разошёлся бы с ней же. Состав закрыт: у
  // двух команд в ответе чужие ключи, у двух — почта пользователя и
  // ссылка активации (замеры спецификатора на живом клиенте).
  const secret = READ_ENDPOINTS
    .filter((endpoint) => endpoint.sensitiveOutput === true)
    .map((endpoint) => endpoint.name);
  assertEquals(secret, [
    "get-user",
    "list-client-ozon-keys",
    "list-client-wb-tokens",
    "list-users",
  ]);
  for (const endpoint of READ_ENDPOINTS) {
    assertEquals(
      commandOf(endpoint.name).logsOutput,
      !secret.includes(endpoint.name),
      `api ${endpoint.name}: пометка журнала разошлась с таблицей`,
    );
  }
  // `get-token` в таблице не объявлен: он кастомный, и вывод у него
  // скрыт своей причиной — живым токеном sl-back.
  assertEquals(commandOf("get-token").logsOutput, false);
});

Deno.test("у каждого path-параметра таблицы есть пояснение", () => {
  // Пояснение необязательно по построению (иначе новый эндпоинт стоил
  // бы двух правок), поэтому полноту стережёт тест: без него справка
  // молча выродилась бы в «clientId: clientId».
  for (const endpoint of READ_ENDPOINTS) {
    for (const name of pathParams(endpoint.path)) {
      assertEquals(
        typeof PATH_ARG_HELP[name],
        "string",
        `нет пояснения к :${name} (эндпоинт ${endpoint.name})`,
      );
    }
  }
});

Deno.test("поля тела собираются в JSON, --body замещает их целиком", async () => {
  const stand = standWith(() => new Response("[]"));
  try {
    const command = commandOf("get-ss-values");
    const io = ioTo(stand.baseUrl, {
      files: { "/тело.json": '{"range":"Z9"}' },
    });
    await run(command, [
      "ss1",
      "--range",
      "A1:B2",
      "--majorDimension",
      "COLUMNS",
    ], io);
    assertEquals(stand.seen[1].method, "POST");
    assertEquals(stand.seen[1].pathname, "/admin/ss/ss1/values");
    assertEquals(stand.seen[1].contentType, "application/json");
    assertEquals(JSON.parse(stand.seen[1].body), {
      range: "A1:B2",
      majorDimension: "COLUMNS",
    });

    await run(command, ["ss1", "--range", "A1:B2", "-b", '{"range":"C3"}'], io);
    assertEquals(JSON.parse(stand.seen[2].body), { range: "C3" });

    await run(command, ["ss1", "--body", "@/тело.json"], io);
    assertEquals(JSON.parse(stand.seen[3].body), { range: "Z9" });
  } finally {
    await stand.stop();
  }
});

Deno.test("ошибки ввода отбиваются до сети", async () => {
  const stand = standWith(() => new Response("не ожидается", { status: 500 }));
  try {
    const command = commandOf("get-ss-values");
    const io = ioTo(stand.baseUrl);
    const missing = await assertRejects(
      () => command.invoke(["ss1"], io),
      UsageError,
    );
    assertEquals(missing.message, "--range обязателен");
    const badBody = await assertRejects(
      () => command.invoke(["ss1", "-b", "{нет"], io),
      UsageError,
    );
    assertStringIncludes(badBody.message, "--body: невалидный JSON: ");
    const noFile = await assertRejects(
      () => command.invoke(["ss1", "-b", "@/нет.json"], io),
      UsageError,
    );
    assertEquals(noFile.message, "--body @/нет.json: file not found");
    // Ни один из трёх отказов не стоил обращения наружу.
    assertEquals(stand.seen.length, 0);
  } finally {
    await stand.stop();
  }
});

Deno.test("get-token: живой кэш печатается без сети", async () => {
  const stand = standWith(() => new Response("не ожидается", { status: 500 }));
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
    assertEquals(text, "из-кэша\n");
    assertEquals(stand.seen.length, 0);
  } finally {
    await stand.stop();
  }
});

Deno.test("get-token: оба флага — свежий логин мимо живого кэша", async () => {
  const stand = startFakeSlback(() => loginReply("новый"));
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
    assertEquals(text, "новый\n");
    assertEquals(JSON.parse(stand.seen[0].body), {
      email: "drugoy@test",
      password: "tajna",
    });
    assertEquals(JSON.parse(written[0]).token, "новый");
  } finally {
    await stand.stop();
  }
});

Deno.test("get-token: один флаг — кэш по-прежнему старше сети", async () => {
  const stand = startFakeSlback(() =>
    new Response("не ожидается", { status: 500 })
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
    assertEquals(text, "из-кэша\n");
    assertEquals(stand.seen.length, 0);
  } finally {
    await stand.stop();
  }
});

Deno.test("get-token: ответ логина без accessToken — свой текст отказа", async () => {
  const stand = startFakeSlback(() => Response.json({ user: { id: 1 } }));
  try {
    const err = await assertRejects(
      () => commandOf("get-token").invoke([], ioTo(stand.baseUrl)),
      DomainError,
    );
    assertEquals(err.message, "нет accessToken в ответе sl-back");
  } finally {
    await stand.stop();
  }
});

Deno.test("get-token не пишет в журнал ни ввода, ни вывода", () => {
  const command = commandOf("get-token");
  assertEquals(command.logsArguments, false);
  assertEquals(command.logsOutput, false);
});

Deno.test("таблица даёт 101 команду с однострокой «метод + путь»", () => {
  // 22 читающих, 68 остатка (`api-write.md`) и одиннадцать кастомных:
  // четыре `ss-access`, `wb-cards-reset` и шесть `wb-loader-*`.
  // Неймспейс переехал целиком.
  assertEquals(apiCommands.length, 101);
  const names = apiCommands.map((command) => command.path[1]);
  // Имя второго сегмента у `ss-access` общее на четыре команды —
  // уникальны пути целиком, а не вторые сегменты.
  const paths = apiCommands.map((command) => command.path.join(" "));
  assertEquals(new Set(paths).size, paths.length);
  assertEquals([...names].sort(), names);
  assertEquals(commandOf("get-client").summary, "GET /admin/client/:userId");
  assertEquals(commandOf("list-wb-cabinets").summary, "GET /admin/wb-cabinets");
  assertEquals(commandOf("create-client").summary, "POST /admin/client");
  for (const command of apiCommands) {
    // Рамка ошибки — полный путь: у трёхуровневых `ss-access` второго
    // сегмента для этого мало.
    assertEquals(command.errorName, command.path.join(" "));
  }
  // Политика следует методу, а не таблице: читающая команда остатка
  // (`auth-verify`) объявлена `ro`, как и вся читающая половина.
  assertEquals(commandOf("get-client").policy, "ro");
  assertEquals(commandOf("auth-verify").policy, "ro");
  assertEquals(commandOf("create-client").policy, "rw");
  assertEquals(commandOf("delete-client").policy, "rw");
});
