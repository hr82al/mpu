/**
 * Остаток неймспейса `mpu api` (`docs/specs/api-write.md`): три
 * механики группы и границы, на которых мутация не должна уходить на
 * сервер.
 *
 * Стенд настоящий, на петле: проверяется ушедшее по сети — метод,
 * адрес, заголовок авторизации и тело, — а не намерения кода. Там, где
 * запрос уходить не должен, проверяется, что стенд не увидел ничего.
 */

import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { type Command, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  type CapturedRequest,
  loginReply,
  startFakeSlback,
} from "../slback/testing.ts";
import { apiCommands } from "./mod.ts";

const TOKEN = "jwt-proba-9f2";

function commandOf(name: string): Command {
  const found = apiCommands.find((command) => command.path[1] === name);
  if (found === undefined) throw new Error(`нет команды api ${name}`);
  return found;
}

/**
 * Порт стенда. `tokenCache: "запрещён"` делает оба конца кэша токена
 * взрывными: команда, которая его тронет, упадёт — это и есть способ
 * увидеть обращение, которого быть не должно.
 */
function ioTo(baseUrl: string, opts: { tokenCache?: "запрещён" } = {}) {
  const banned = opts.tokenCache === "запрещён";
  let cache: string | undefined;
  const values: Record<string, string> = {
    BASE_API_URL: baseUrl,
    TOKEN_EMAIL: "kto@test",
    TOKEN_PASSWORD: "parol",
  };
  return makeFakeIo({
    readTokenCache: () => {
      if (banned) throw new Error("кэш токена тронут на чтение");
      return Promise.resolve(cache);
    },
    writeTokenCache: (text) => {
      if (banned) throw new Error("кэш токена тронут на запись");
      cache = text;
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

/** Стенд: логин на первый вызов, затем ответ `body`. */
function standWith(
  body: (seen: readonly CapturedRequest[]) => Response = () =>
    new Response('{"ok":true}'),
) {
  return startFakeSlback((seen) =>
    seen.length === 1 ? loginReply(TOKEN) : body(seen)
  );
}

/** Стенд без логина: первый же вызов получает ответ. */
function standBare() {
  return startFakeSlback(() => new Response('{"ok":true}'));
}

it("POST с объявленными полями: метод, адрес и тело", async () => {
  const stand = await standWith();
  try {
    await commandOf("create-client").invoke(
      ["--title", "Клиент", "--is_active", "true", "--id", "777"],
      ioTo(stand.baseUrl),
    );
    const sent = stand.seen[1];
    expect([sent.method, sent.pathname]).toStrictEqual([
      "POST",
      "/admin/client",
    ]);
    // Типы полей взяты из объявления: число числом, булево булевым.
    expect(JSON.parse(sent.body)).toStrictEqual({
      id: 777,
      title: "Клиент",
      is_active: true,
    });
    expect(sent.authorization).toStrictEqual(`Bearer ${TOKEN}`);
  } finally {
    await stand.stop();
  }
});

it("поле, которого нет в объявлении, — отказ до сети", async () => {
  const stand = await standWith();
  try {
    await expect(
      commandOf("create-client").invoke(
        ["--title", "Клиент", "--нет-такого-поля", "x"],
        ioTo(stand.baseUrl),
      ),
    ).rejects.toThrow(UsageError);
    // Ни одного запроса, включая логин: разбор ввода предшествует сети.
    expect(stand.seen.length).toBe(0);
  } finally {
    await stand.stop();
  }
});

it("нет обязательного path-параметра — отказ до сети", async () => {
  const stand = await standWith();
  try {
    await expect(commandOf("delete-client").invoke([], ioTo(stand.baseUrl)))
      .rejects.toThrow(UsageError);
    // Мутация на угаданном адресе (`DELETE /admin/client/`) не уходит:
    // пустой сегмент — это чужая строка, а не наша.
    expect(stand.seen.length).toBe(0);
  } finally {
    await stand.stop();
  }
});

describe("path-параметр со слэшем не меняет адрес запроса", () => {
  it("слэш экранируется", async () => {
    const stand = await standWith();
    try {
      await commandOf("delete-client-ss-dataset").invoke(
        ["777", "1BxiMVs0", "Лист/1"],
        ioTo(stand.baseUrl),
      );
      const sent = stand.seen[1];
      // Значение осталось одним сегментом: соседний эндпоинт адресом
      // не стал.
      expect(sent.pathname).toBe(
        "/admin/client/777/ss/1BxiMVs0/dataset/%D0%9B%D0%B8%D1%81%D1%82%2F1",
      );
      expect(sent.method).toBe("DELETE");
    } finally {
      await stand.stop();
    }
  });

  it("«..» отбивается как ввод, а не экранируется", async () => {
    const stand = await standWith();
    try {
      const err = await rejected(() =>
        commandOf("delete-client").invoke(
          [".."],
          ioTo(stand.baseUrl),
        ), UsageError);
      expect(err.message).toContain("сегмент пути");
      expect(stand.seen.length).toBe(0);
    } finally {
      await stand.stop();
    }
  });
});

describe("произвольное тело: объект уходит как есть", () => {
  // Механика самая частая в группе — 42 команды из 68, — поэтому
  // проверяется на нескольких, и разных методов.
  const cases: readonly (readonly [string, readonly string[], string])[] = [
    ["create-client", [], "/admin/client"],
    ["update-client", ["777"], "/admin/client/777"],
  ];
  for (const [name, args, path] of cases) {
    it(name, async () => {
      const stand = await standWith();
      try {
        await commandOf(name).invoke(
          [...args, "--body", '{"title":"из тела","extra":{"вложенное":1}}'],
          ioTo(stand.baseUrl),
        );
        const sent = stand.seen[1];
        expect(sent.pathname).toStrictEqual(path);
        // Тело уходит дословно, включая поля, которых в объявлении
        // нет: в этом и смысл признака.
        expect(JSON.parse(sent.body)).toStrictEqual({
          title: "из тела",
          extra: { "вложенное": 1 },
        });
      } finally {
        await stand.stop();
      }
    });
  }
});

describe("произвольное тело остаётся объектом", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["массив", "[1,2]"],
    ["строка", '"строка"'],
    ["число", "42"],
    ["null", "null"],
  ];
  for (const [title, raw] of cases) {
    it(title, async () => {
      const stand = await standWith();
      try {
        const err = await rejected(() =>
          commandOf("create-client").invoke(
            ["--body", raw],
            ioTo(stand.baseUrl),
          ), UsageError);
        // Отказ здесь, а не от сервера: иначе причина пришла бы чужим
        // текстом и после запроса.
        expect(err.message).toContain("ожидается объект JSON");
        expect(stand.seen.length).toBe(0);
      } finally {
        await stand.stop();
      }
    });
  }
});

describe("no_auth: без заголовка и без единого касания кэша", () => {
  for (const name of ["auth-login", "ss-datasets-update"]) {
    it(name, async () => {
      const stand = await standBare();
      try {
        const argv = name === "auth-login"
          ? ["--email", "kto@test", "--password", "parol"]
          : ["--spreadsheet_id", "1BxiMVs0"];
        // Кэш токена взрывной: любое обращение к нему уронит вызов.
        await commandOf(name).invoke(
          argv,
          ioTo(stand.baseUrl, {
            tokenCache: "запрещён",
          }),
        );
        // Ровно один запрос — сам вызов. Логина перед ним нет: у
        // `auth-login` он был бы порочным кругом.
        expect(stand.seen.length).toBe(1);
        expect(stand.seen[0].authorization).toStrictEqual(null);
      } finally {
        await stand.stop();
      }
    });
  }
});

it("обычная команда авторизуется и кэш токена трогает", async () => {
  // Обратная сторона предыдущего: без неё «не трогает кэш» прошло бы
  // и у команды, которая не работает вовсе.
  const stand = await standWith();
  try {
    await commandOf("delete-client").invoke(["777"], ioTo(stand.baseUrl));
    expect(stand.seen.length).toBe(2);
    expect(stand.seen[0].pathname).toBe("/auth/login");
    expect(stand.seen[1].authorization).toStrictEqual(`Bearer ${TOKEN}`);
  } finally {
    await stand.stop();
  }
});
