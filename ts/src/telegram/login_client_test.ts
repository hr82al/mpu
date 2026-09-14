/**
 * Что в живом входе проверяемо без сети: формат строки сессии, которую он
 * записывает, и отказы без сети — сбой криптографии и отказ, не
 * относящийся к ней (соединение подменено отказом, клиент закрыт во время
 * попытки).
 *
 * `TELEGRAM_SESSION` — внешняя граница (`platform/telegram-mtproto.md`):
 * ту же строку читают обе реализации, и наш сеанс переводит её
 * `convertFromTelethonSession` (`session.ts`). Записать туда родной
 * формат клиента значило бы сломать после успешного входа всё
 * семейство разом — а увидеть это можно было бы только живым входом,
 * который отзывает сессию владельца. Поэтому сверка здесь, на паре
 * конвертеров, а не там.
 */

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { VerbatimError } from "../command/mod.ts";
import {
  convertFromTelethonSession,
  serializeTelethonSession,
} from "@mtcute/convert";
import {
  BaseTelegramClient,
  MtcuteError,
  TelegramClient,
  tl,
} from "@mtcute/deno";
import { CryptoInitError } from "./errors.ts";
import {
  loginRefusal,
  openLoginClient,
  sharedSessionString,
} from "./login_client.ts";

/** Синтетическая сессия: ключ нулевой, адрес — тестовый DC Telegram. */
const TELETHON = serializeTelethonSession({
  dcId: 2,
  ipAddress: "149.154.167.51",
  ipv6: false,
  port: 443,
  authKey: new Uint8Array(256),
});

/**
 * Запоминает методы прототипа клиента перед подменой и отдаёт их
 * восстановление: метод, лежавший выше по цепочке, возвращается снятием
 * подмены, а не записью копии — иначе после теста на прототипе остаются
 * собственные свойства.
 */
function saveMethods(proto: object, names: readonly string[]): () => void {
  const saved = names.map((name) => ({
    name,
    own: Object.hasOwn(proto, name),
    real: Reflect.get(proto, name) as unknown,
  }));
  return () => {
    for (const { name, own, real } of saved) {
      if (own) Reflect.set(proto, name, real);
      else Reflect.deleteProperty(proto, name);
    }
  };
}

Deno.test("вход пишет строку в формате прежней реализации, а не своём", () => {
  // Читатель ждёт формат telethon: то, что он разбирает, вход и обязан
  // записывать. Мутация «вернуть экспорт клиента как есть» краснеет
  // здесь, а не на живом входе.
  const asRead = convertFromTelethonSession(TELETHON);
  assertEquals(sharedSessionString(asRead), TELETHON);
});

Deno.test("записанное читается тем же путём, что и в сеансе", () => {
  // Круг замкнут: строка, которую вход положит в env-файл, проходит
  // ровно тот конвертер, которым её берёт `session.ts`.
  const written = sharedSessionString(convertFromTelethonSession(TELETHON));
  const parsed = convertFromTelethonSession(written);
  assertEquals(parsed.primaryDcs.main.id, 2);
  assertEquals(parsed.authKey.length, 256);
});

Deno.test("вход до сети: сбой криптографии печатается текстом спеки, а не обёрткой операции", async () => {
  // `platform/telegram-mtproto.md`, «Конфигурация»: правило одно для всех
  // подкоманд, включая вход. Криптография поднимается до соединения, и
  // живой вход — с отзывом сессии — сюда не доходит.
  const client = openLoginClient({ apiId: "1", apiHash: "проба" }, undefined);
  const realReadFile = Deno.readFile;
  try {
    Deno.readFile = () =>
      Promise.reject(new Deno.errors.NotFound("нет встроенного модуля"));
    const err = await assertRejects(
      () =>
        client.signIn("+70000000000", {
          ask: () => Promise.resolve(undefined),
          askSecret: () => Promise.resolve(undefined),
          progress: () => {},
        }),
      VerbatimError,
    );
    assertEquals(
      err.message,
      "telegram: криптография клиента не поднялась: нет встроенного модуля",
    );
  } finally {
    Deno.readFile = realReadFile;
    await client.close();
  }
});

Deno.test("вход: отказ, не относящийся к криптографии, не выдаётся за неё", async () => {
  // Криптография поднимается настоящая, а соединение с узлом отказывает:
  // подменённый `Deno.connect` отмечает попытку и отказывает, наружу не
  // уходит ничего. Клиент на отказ соединения переподключается, пока не
  // выйдет предел соединения (20 с по поддельным часам), — его отказ и есть
  // отказ, не относящийся к криптографии.
  using time = new FakeTime();
  const client = openLoginClient({ apiId: "1", apiHash: "проба" }, undefined);
  const connecting = Promise.withResolvers<void>();
  const realConnect = Deno.connect;
  try {
    // `Reflect.set`, а не присваивание: у `Deno.connect` три перегрузки, и
    // подмена, отвечающая на все одним отказом, в их тип не приводится без
    // двойного приведения.
    Reflect.set(Deno, "connect", () => {
      connecting.resolve();
      return Promise.reject(
        new Deno.errors.NotCapable("соединение в тесте запрещено"),
      );
    });
    const signing = client.signIn("+70000000000", {
      ask: () => Promise.resolve(undefined),
      askSecret: () => Promise.resolve(undefined),
      progress: () => {},
    }).then(
      () => "вошёл",
      (err: unknown) => err,
    );
    // Гонка, а не одно ожидание соединения: откажи вход раньше попытки,
    // тест покраснел бы на проверках ниже, а не завис.
    await Promise.race([connecting.promise, signing]);
    await time.tickAsync(20_000);
    const outcome = await signing;
    assertEquals(outcome instanceof VerbatimError, true, String(outcome));
    const text = outcome instanceof Error ? outcome.message : String(outcome);
    assertEquals(text.startsWith("telegram: "), true, text);
    assertEquals(text.includes("криптография"), false, text);
  } finally {
    Reflect.set(Deno, "connect", realConnect);
    await client.close();
  }
});

Deno.test("вход: дефект внутри входа уходит из signIn тем же объектом", async () => {
  // Место вызова `loginRefusal`: подменить его переоформлением любого
  // отказа — и дефект своего кода станет «пропущено» (инвариант 3).
  // Соединение и сам вход подменены, сети нет.
  const proto = TelegramClient.prototype;
  const restore = saveMethods(proto, ["connect", "start"]);
  const defect = new TypeError("дефект внутри входа");
  const client = openLoginClient({ apiId: "1", apiHash: "проба" }, undefined);
  try {
    Reflect.set(proto, "connect", function (this: TelegramClient) {
      this.onConnectionState.emit("connected");
      return Promise.resolve();
    });
    Reflect.set(proto, "start", () => Promise.reject(defect));
    const err = await assertRejects(() =>
      client.signIn("+70000000000", {
        ask: () => Promise.resolve(undefined),
        askSecret: () => Promise.resolve(undefined),
        progress: () => {},
      })
    );
    assertStrictEquals(err, defect);
  } finally {
    restore();
    await client.close();
  }
});

/** Вопросы человеку, которые `start` клиента получает от входа. */
interface HumanQuestions {
  readonly code: () => Promise<string>;
  readonly password: () => Promise<string>;
}

Deno.test("вход: ожидание человека под предел первого ответа не попадает", async (t) => {
  // Спека: предел — на первый ответ входа до вопроса; код и пароль второго
  // фактора человек набирает сколько угодно. Двойник отвечает через 70 с
  // поддельного времени — дольше предела входа (60 с): отказа нет, вход
  // завершается.
  const cases = [
    {
      name: "код",
      question: (params: HumanQuestions) => params.code(),
    },
    {
      name: "пароль второго фактора без кода",
      question: (params: HumanQuestions) => params.password(),
    },
  ];
  for (const { name, question } of cases) {
    await t.step(name, async () => {
      using time = new FakeTime();
      const proto = TelegramClient.prototype;
      const restore = saveMethods(proto, ["connect", "start", "exportSession"]);
      const asked = Promise.withResolvers<void>();
      const client = openLoginClient(
        { apiId: "1", apiHash: "проба" },
        undefined,
      );
      try {
        Reflect.set(proto, "connect", function (this: TelegramClient) {
          this.onConnectionState.emit("connected");
          return Promise.resolve();
        });
        Reflect.set(proto, "start", async (params: HumanQuestions) => {
          await question(params);
          return {};
        });
        Reflect.set(
          proto,
          "exportSession",
          () => Promise.resolve(convertFromTelethonSession(TELETHON)),
        );
        const answerLater = () => {
          asked.resolve();
          return new Promise<string>((resolve) =>
            setTimeout(() => resolve("ответ"), 70_000)
          );
        };
        let settled = false;
        const signing = client.signIn("+70000000000", {
          ask: answerLater,
          askSecret: answerLater,
          progress: () => {},
        }).then(
          (session) => session,
          (err: unknown) => err,
        ).finally(() => {
          settled = true;
        });
        await Promise.race([asked.promise, signing]);
        await time.tickAsync(70_000);
        for (let turn = 0; turn < 20 && !settled; turn++) {
          await time.runMicrotasks();
        }
        assertEquals(settled, true, "вход не завершился после ответа человека");
        assertEquals(await signing, TELETHON);
      } finally {
        restore();
        await client.close();
      }
    });
  }
});

Deno.test("вход: сообщения клиента о ходе входа — строками хода, не в stdout", async (t) => {
  // «stdout входа» (`telegram-login.md`, инвариант 3): без обработчиков
  // `start` библиотеки печатает «The confirmation code has been sent via …»
  // и «Invalid code…» прямым `console.log`, мимо платформы клиента.
  // Исполняется настоящий `start`; подменены только соединение и запросы к
  // Telegram на внутреннем клиенте.
  const cases = [
    {
      // Первый код не подошёл, второго человек не ввёл.
      name: "код отправлен по SMS, первый не подошёл",
      sentCodeType: { _: "auth.sentCodeTypeSms", length: 5 },
      refusal: "PHONE_CODE_EMPTY",
      progress: [
        "# telegram: код подтверждения отправлен (sms)",
        "# telegram: код не подошёл, попробуй ещё раз",
      ],
      questions: 2,
    },
    {
      // Без обработчика библиотека отказывает сама; обработчик этот отказ
      // снимает и обязан его повторить — иначе вход спросил бы код, который
      // не придёт.
      name: "нужна настройка почты — отказ, кода не спрашивают",
      sentCodeType: { _: "auth.sentCodeTypeSetUpEmailRequired" },
      refusal: "Email login setup is required to sign in",
      progress: [],
      questions: 0,
    },
  ];
  for (const { name, sentCodeType, refusal, progress, questions } of cases) {
    await t.step(name, async () => {
      const restoreClient = saveMethods(TelegramClient.prototype, ["connect"]);
      const restoreBase = saveMethods(BaseTelegramClient.prototype, ["call"]);
      const printed: unknown[][] = [];
      const realLog = console.log;
      const lines: string[] = [];
      const answers = ["12345"];
      let asked = 0;
      const client = openLoginClient(
        { apiId: "1", apiHash: "проба" },
        undefined,
      );
      try {
        console.log = (...args: unknown[]) => void printed.push(args);
        Reflect.set(
          TelegramClient.prototype,
          "connect",
          function (this: TelegramClient) {
            this.onConnectionState.emit("connected");
            return Promise.resolve();
          },
        );
        Reflect.set(
          BaseTelegramClient.prototype,
          "call",
          (request: { readonly _: string }) => {
            switch (request._) {
              case "users.getUsers":
                return Promise.reject(
                  new tl.RpcError(401, "AUTH_KEY_UNREGISTERED"),
                );
              case "auth.sendCode":
                return Promise.resolve({
                  _: "auth.sentCode",
                  type: sentCodeType,
                  phoneCodeHash: "хеш",
                });
              case "auth.signIn":
                return Promise.reject(
                  new tl.RpcError(400, "PHONE_CODE_INVALID"),
                );
              default:
                return Promise.reject(
                  new Error(`неожиданный запрос ${request._}`),
                );
            }
          },
        );
        const err = await assertRejects(
          () =>
            client.signIn("+70000000000", {
              ask: () => {
                asked++;
                return Promise.resolve(answers.shift());
              },
              askSecret: () => Promise.resolve(undefined),
              progress: (line) => void lines.push(line),
            }),
          VerbatimError,
        );
        assertEquals(err.message.includes(refusal), true, err.message);
        assertEquals(printed, [], "библиотека писала в stdout");
        assertEquals(lines, progress, "строки хода");
        assertEquals(asked, questions, "число вопросов кода");
      } finally {
        console.log = realLog;
        restoreBase();
        restoreClient();
        await client.close();
      }
    });
  }
});

Deno.test("вход: неверный пароль и неверный код — каждый своей строкой хода", async () => {
  // Настоящий путь неверного пароля идёт через SRP-расчёт перед
  // `auth.checkPassword`, поэтому здесь `start` подменён: он зовёт
  // обработчик неверного ввода в том порядке, что и библиотека, — сначала
  // цикл кода, затем, после `SESSION_PASSWORD_NEEDED`, цикл пароля.
  const proto = TelegramClient.prototype;
  const restore = saveMethods(proto, ["connect", "start", "exportSession"]);
  const lines: string[] = [];
  const client = openLoginClient({ apiId: "1", apiHash: "проба" }, undefined);
  try {
    Reflect.set(proto, "connect", function (this: TelegramClient) {
      this.onConnectionState.emit("connected");
      return Promise.resolve();
    });
    Reflect.set(
      proto,
      "start",
      async (params: {
        readonly invalidCodeCallback: (
          type: "code" | "password",
        ) => Promise<void> | void;
      }) => {
        await params.invalidCodeCallback("code");
        await params.invalidCodeCallback("password");
        return {};
      },
    );
    Reflect.set(
      proto,
      "exportSession",
      () => Promise.resolve(convertFromTelethonSession(TELETHON)),
    );
    const session = await client.signIn("+70000000000", {
      ask: () => Promise.resolve(undefined),
      askSecret: () => Promise.resolve(undefined),
      progress: (line) => void lines.push(line),
    });
    assertEquals(session, TELETHON);
    assertEquals(lines, [
      "# telegram: код не подошёл, попробуй ещё раз",
      "# telegram: пароль не подошёл, попробуй ещё раз",
    ]);
  } finally {
    restore();
    await client.close();
  }
});

Deno.test("отказ входа: текстом слоя — только отказ библиотеки, прочее как есть", async (t) => {
  // Инвариант 3 (`telegram-login.md`, «Что считается сбоем самого входа»):
  // отказ протокола, библиотеки и криптографии оформляется строкой слоя и
  // становится пропуском; дефект кода и отказ терминала — нет.
  await t.step("отказ протокола — RPC error", () => {
    const err = loginRefusal(new tl.RpcError(400, "PHONE_CODE_INVALID"));
    assertEquals(err instanceof VerbatimError, true, String(err));
    assertEquals(
      err instanceof Error ? err.message : "",
      "telegram: RPC error: PHONE_CODE_INVALID",
    );
  });
  await t.step("отказ библиотеки — строкой слоя", () => {
    const err = loginRefusal(new MtcuteError("Session is reset"));
    assertEquals(err instanceof VerbatimError, true, String(err));
  });
  await t.step("сбой криптографии — текстом спеки", () => {
    const err = loginRefusal(new CryptoInitError("нет встроенного модуля"));
    assertEquals(
      err instanceof Error ? err.message : "",
      "telegram: криптография клиента не поднялась: нет встроенного модуля",
    );
  });
  await t.step("дефект своего кода — как есть", () => {
    const bug = new TypeError("дефект своего кода");
    assertEquals(loginRefusal(bug), bug);
  });
  await t.step("отказ терминала — как есть", () => {
    const refused = new Error("терминал: не удалось прочитать ответ");
    assertEquals(loginRefusal(refused), refused);
  });
});
