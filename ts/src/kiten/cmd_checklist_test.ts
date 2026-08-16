/**
 * Чек-листы карточки — `mpu kiten checklist ls | add | check | uncheck`
 * (`docs/specs/kiten-checklist.md`). Вызов идёт от argv, как из точки
 * входа, а каталог ходит в фейковый Kaiten на петле
 * (`../kaiten/testing.ts`): так под проверку попадает и состав запросов,
 * который у этой команды сам по себе инвариант — ошибка ссылки на пункт
 * не смеет отправить ни одного мутирующего запроса, а повторный `add` не
 * смеет создать второй чек-лист.
 *
 * Сервер отдаёт пункты в порядке, не совпадающем ни с `sort_order`, ни с
 * `id` (замер спеки), поэтому побайтовое совпадение с голденами `ls` и
 * с перечнями кандидатов и есть проверка сортировки.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type Command,
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
import {
  kitenChecklistAddCommand,
  kitenChecklistCheckCommand,
  kitenChecklistLsCommand,
  kitenChecklistUncheckCommand,
} from "./mod.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";
const CARD_ID = 10000001;
const SELECTOR = String(CARD_ID);

const CARD_PATH = `/api/latest/cards/${CARD_ID}`;
const CHECKLISTS_PATH = `${CARD_PATH}/checklists`;
const LIST_ID = 11960707;
const SECOND_LIST_ID = 11960716;
const itemsPath = (checklistId: number) =>
  `${CHECKLISTS_PATH}/${checklistId}/items`;
const itemPath = (checklistId: number, itemId: number) =>
  `${itemsPath(checklistId)}/${itemId}`;

/** Адрес карточки в голденах: снят с обезличенного живого прогона. */
const GOLDEN_CARD_URL = `https://kaiten.example.test/${CARD_ID}`;

/** Пункт в форме ответа сервера. */
function rawItem(
  id: number,
  text: string,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, text, checked: false, sort_order: 1, ...patch };
}

/** Три пункта голденов; порядок ответа — не порядок сортировки. */
const GOLDEN_ITEMS = [
  rawItem(66835646, "Гейты зелёные", { sort_order: 2 }),
  rawItem(66835645, "Тест написан", { sort_order: 1 }),
  rawItem(66835647, "Третий пункт", { sort_order: 3 }),
];

/** Чек-лист голденов «Проверки» с тремя пунктами. */
function goldenChecklist(
  items: readonly Record<string, unknown>[] = GOLDEN_ITEMS,
): Record<string, unknown> {
  return { id: LIST_ID, name: "Проверки", items };
}

function rawCard(
  checklists: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { id: CARD_ID, title: "Карточка стенда", checklists };
}

function golden(name: string): Promise<string> {
  return Deno.readTextFile(
    new URL(`testdata/kiten-checklist/${name}`, import.meta.url),
  );
}

/** Голден с адресом карточки под стенд: базовый URL у него свой. */
async function expected(name: string, baseUrl: string): Promise<string> {
  return (await golden(name)).replaceAll(
    GOLDEN_CARD_URL,
    `${baseUrl}/${CARD_ID}`,
  );
}

/** Чем отвечать на «МЕТОД путь»; пара вне таблицы — красный тест. */
type Routes = Readonly<Record<string, (body: string) => Response>>;

interface Stand {
  readonly io: CommandIo;
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly stop: () => Promise<void>;
}

function stand(routes: Routes): Stand {
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    const route = routes[`${last.method} ${last.pathname}`];
    return route === undefined
      ? new Response("вызов, которого тест не ждал", { status: 500 })
      : route(last.body);
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
  });
  return { io, baseUrl: fake.baseUrl, seen: fake.seen, stop: fake.stop };
}

/** Стенд, отдающий карточку с этими чек-листами, плюс лишние маршруты. */
function cardStand(
  checklists: readonly Record<string, unknown>[],
  extra: Routes = {},
): Stand {
  return stand({
    [`GET ${CARD_PATH}`]: () => Response.json(rawCard(checklists)),
    ...extra,
  });
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

/** Тела запросов в порядке обращения; GET пропущены. */
function bodies(seen: readonly CapturedRequest[]): readonly unknown[] {
  return seen.filter((request) => request.method !== "GET").map((request) =>
    JSON.parse(request.body)
  );
}

/** Текст ошибки так, как его напечатает точка входа, с переводом строки. */
async function errorText(
  command: Command,
  argv: readonly string[],
  io: CommandIo,
  kind: typeof UsageError | typeof DomainError,
): Promise<string> {
  const err = await assertRejects(() => command.invoke(argv, io), kind);
  return `${formatCommandError(command.errorName, err)}\n`;
}

Deno.test("checklist ls: сортировка, обе формы вывода и один вызов", async (t) => {
  await t.step("таблица — голден побайтово", async () => {
    const { io, seen, stop } = cardStand([goldenChecklist()]);
    try {
      assertEquals(
        await output(kitenChecklistLsCommand, [SELECTOR], io),
        await golden("ls-stdout.txt"),
      );
      assertEquals(calls(seen), [`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  await t.step("--json — голден побайтово", async () => {
    const { io, stop } = cardStand([goldenChecklist()]);
    try {
      assertEquals(
        await output(kitenChecklistLsCommand, [SELECTOR, "--json"], io),
        await golden("ls-json-stdout.txt"),
      );
    } finally {
      await stop();
    }
  });

  await t.step("чек-листов нет — голден и пустой массив", async () => {
    const { io, stop } = cardStand([]);
    try {
      assertEquals(
        await output(kitenChecklistLsCommand, [SELECTOR], io),
        await golden("ls-empty-stdout.txt"),
      );
      assertEquals(
        await output(kitenChecklistLsCommand, [SELECTOR, "--json"], io),
        "[]\n",
      );
    } finally {
      await stop();
    }
  });

  await t.step("чек-лист без пунктов — заголовок и одна шапка", async () => {
    const { io, stop } = cardStand([{ id: LIST_ID, name: "Пусто", items: [] }]);
    try {
      assertEquals(
        await output(kitenChecklistLsCommand, [SELECTOR], io),
        `Пусто · 0/0 (checklist id ${LIST_ID})\n id  ✓  text \n`,
      );
    } finally {
      await stop();
    }
  });

  await t.step("два чек-листа — два блока через пустую строку", async () => {
    const { io, stop } = cardStand([
      { id: LIST_ID, name: "Первый", items: [rawItem(1, "раз")] },
      { id: SECOND_LIST_ID, name: "Второй", items: [] },
    ]);
    try {
      const text = await output(kitenChecklistLsCommand, [SELECTOR], io);
      assertEquals(text.split("\n\n").length, 2);
      assertStringIncludes(text, `Первый · 0/1 (checklist id ${LIST_ID})`);
      assertStringIncludes(
        text,
        `Второй · 0/0 (checklist id ${SECOND_LIST_ID})`,
      );
    } finally {
      await stop();
    }
  });

  await t.step("чек-листы в убывающем id — блоки по возрастанию", async () => {
    // Фейк отдаёт их в обратном порядке нарочно: на живой карточке они
    // шли по возрастанию сами собой, и такой прогон ничего не проверял бы.
    const { io, stop } = cardStand([
      { id: SECOND_LIST_ID, name: "Второй", items: [rawItem(2, "два")] },
      { id: LIST_ID, name: "Первый", items: [rawItem(1, "раз")] },
    ]);
    try {
      const text = await output(kitenChecklistLsCommand, [SELECTOR], io);
      assertEquals(
        text.split("\n").filter((line) => line.includes("checklist id")),
        [
          `Первый · 0/1 (checklist id ${LIST_ID})`,
          `Второй · 0/1 (checklist id ${SECOND_LIST_ID})`,
        ],
      );
    } finally {
      await stop();
    }
  });

  await t.step("отметка пункта видна как [x]", async () => {
    const { io, stop } = cardStand([
      {
        id: LIST_ID,
        name: "Проверки",
        items: [rawItem(66835645, "Тест написан", { checked: true })],
      },
    ]);
    try {
      const text = await output(kitenChecklistLsCommand, [SELECTOR], io);
      assertStringIncludes(text, "Проверки · 1/1");
      assertStringIncludes(text, "[x]  Тест написан");
    } finally {
      await stop();
    }
  });

  await t.step("отказ чтения карточки — доменная ошибка", async () => {
    const { io, stop } = stand({
      [`GET ${CARD_PATH}`]: () => new Response("boom", { status: 500 }),
    });
    try {
      assertStringIncludes(
        await errorText(kitenChecklistLsCommand, [SELECTOR], io, DomainError),
        "mpu kiten checklist ls: kaiten error:",
      );
    } finally {
      await stop();
    }
  });

  await t.step("пункт без sort_order идёт как с нулевым", async () => {
    const { io, stop } = cardStand([{
      id: LIST_ID,
      name: "Проверки",
      items: [
        rawItem(2, "второй", { sort_order: 1 }),
        rawItem(1, "первый", { sort_order: undefined }),
      ],
    }]);
    try {
      const text = await output(kitenChecklistLsCommand, [SELECTOR], io);
      const ids = text.split("\n").slice(2, 4).map((line) =>
        line.trim().split(/\s+/)[0]
      );
      assertEquals(ids, ["1", "2"]);
    } finally {
      await stop();
    }
  });
});

Deno.test("checklist add: создание, идемпотентность и sort_order", async (t) => {
  await t.step("чек-листа нет — создан, два пункта", async () => {
    const { io, baseUrl, seen, stop } = cardStand([], {
      [`POST ${CHECKLISTS_PATH}`]: () =>
        Response.json({ id: LIST_ID, name: "Проверки", items: [] }),
      [`POST ${itemsPath(LIST_ID)}`]: (body) =>
        Response.json({ id: 66835645, ...JSON.parse(body) }),
    });
    try {
      assertEquals(
        await output(kitenChecklistAddCommand, [
          SELECTOR,
          "-n",
          "Проверки",
          "-i",
          "Тест написан",
          "-i",
          "Гейты зелёные",
        ], io),
        await expected("add-created-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `POST ${CHECKLISTS_PATH}`,
        `POST ${itemsPath(LIST_ID)}`,
        `POST ${itemsPath(LIST_ID)}`,
      ]);
      assertEquals(bodies(seen), [
        { name: "Проверки" },
        { text: "Тест написан", checked: false, sort_order: 1 },
        { text: "Гейты зелёные", checked: false, sort_order: 2 },
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("чек-лист существует — пункта создания нет", async () => {
    const existing = goldenChecklist([
      rawItem(66835645, "Тест написан", { sort_order: 1 }),
      rawItem(66835646, "Гейты зелёные", { sort_order: 2 }),
    ]);
    const { io, baseUrl, seen, stop } = cardStand([existing], {
      [`POST ${itemsPath(LIST_ID)}`]: (body) =>
        Response.json({ id: 66835647, ...JSON.parse(body) }),
    });
    try {
      assertEquals(
        await output(kitenChecklistAddCommand, [
          SELECTOR,
          "-n",
          "Проверки",
          "-i",
          "Тест написан",
          "-i",
          "Третий пункт",
        ], io),
        await expected("add-existing-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `POST ${itemsPath(LIST_ID)}`,
      ]);
      // Пропущенный текст номер всё равно занял: у нового пункта
      // максимум (2) плюс порядковый номер его флага (2).
      assertEquals(bodies(seen), [
        { text: "Третий пункт", checked: false, sort_order: 4 },
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("без -i — чек-лист создан, добавлено 0", async () => {
    const { io, baseUrl, seen, stop } = cardStand([], {
      [`POST ${CHECKLISTS_PATH}`]: () =>
        Response.json({ id: SECOND_LIST_ID, name: "Второй список", items: [] }),
    });
    try {
      assertEquals(
        await output(
          kitenChecklistAddCommand,
          [SELECTOR, "-n", "Второй список"],
          io,
        ),
        await expected("add-name-only-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `POST ${CHECKLISTS_PATH}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("все тексты уже есть — ни одного POST пункта", async () => {
    const { io, seen, stop } = cardStand([goldenChecklist()]);
    try {
      const text = await output(kitenChecklistAddCommand, [
        SELECTOR,
        "-n",
        "Проверки",
        "-i",
        "Тест написан",
        "-i",
        "Третий пункт",
      ], io);
      assertStringIncludes(text, "(существующий, id 11960707)");
      assertStringIncludes(text, "добавлено пунктов: 0");
      assertEquals(calls(seen), [`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  await t.step("повтор текста внутри вызова — один пункт", async () => {
    const { io, seen, stop } = cardStand([], {
      [`POST ${CHECKLISTS_PATH}`]: () =>
        Response.json({ id: LIST_ID, name: "Проверки", items: [] }),
      [`POST ${itemsPath(LIST_ID)}`]: (body) =>
        Response.json({ id: 66835645, ...JSON.parse(body) }),
    });
    try {
      const text = await output(kitenChecklistAddCommand, [
        SELECTOR,
        "-n",
        "Проверки",
        "-i",
        "Тест написан",
        "-i",
        "Тест написан",
      ], io);
      assertStringIncludes(text, "добавлено пунктов: 1");
      assertEquals(bodies(seen), [
        { name: "Проверки" },
        { text: "Тест написан", checked: false, sort_order: 1 },
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("отказ на середине списка называет число", async () => {
    let posted = 0;
    const { io, stop } = cardStand([], {
      [`POST ${CHECKLISTS_PATH}`]: () =>
        Response.json({ id: LIST_ID, name: "Проверки", items: [] }),
      [`POST ${itemsPath(LIST_ID)}`]: (body) => {
        posted++;
        return posted === 1
          ? Response.json({ id: 66835645, ...JSON.parse(body) })
          : new Response("boom", { status: 500 });
      },
    });
    try {
      const text = await errorText(
        kitenChecklistAddCommand,
        [SELECTOR, "-n", "Проверки", "-i", "раз", "-i", "два"],
        io,
        DomainError,
      );
      assertStringIncludes(text, "mpu kiten checklist add: kaiten error:");
      assertStringIncludes(text, "добавлено пунктов: 1");
    } finally {
      await stop();
    }
  });

  await t.step("одноимённые чек-листы — берётся меньший id", async () => {
    // Фейк отдаёт их по убыванию id: выбор «первый в ответе сервера»
    // взял бы больший и упёрся бы в незаданный маршрут его пунктов.
    const { io, seen, stop } = cardStand([
      { id: SECOND_LIST_ID, name: "Проверки", items: [] },
      { id: LIST_ID, name: "Проверки", items: [] },
    ], {
      [`POST ${itemsPath(LIST_ID)}`]: (body) =>
        Response.json({ id: 66835645, ...JSON.parse(body) }),
    });
    try {
      const text = await output(kitenChecklistAddCommand, [
        SELECTOR,
        "-n",
        "Проверки",
        "-i",
        "Тест написан",
      ], io);
      assertStringIncludes(text, `(существующий, id ${LIST_ID})`);
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `POST ${itemsPath(LIST_ID)}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("без --name — ошибка ввода до сети", async () => {
    const { io, seen, stop } = cardStand([]);
    try {
      await assertRejects(
        () => kitenChecklistAddCommand.invoke([SELECTOR], io),
        UsageError,
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("отказ чтения карточки — доменная ошибка", async () => {
    const { io, stop } = stand({
      [`GET ${CARD_PATH}`]: () => new Response("boom", { status: 500 }),
    });
    try {
      const text = await errorText(
        kitenChecklistAddCommand,
        [SELECTOR, "-n", "Проверки"],
        io,
        DomainError,
      );
      assertStringIncludes(text, "mpu kiten checklist add: kaiten error:");
    } finally {
      await stop();
    }
  });
});

Deno.test("checklist check/uncheck: резолв пункта и один PATCH", async (t) => {
  /** Стенд карточки голденов с ответом отметки. */
  function markStand(
    checklists: readonly Record<string, unknown>[] = [goldenChecklist()],
  ): Stand {
    const routes: Record<string, (body: string) => Response> = {};
    for (const checklist of checklists) {
      const items = checklist.items as readonly Record<string, unknown>[];
      for (const item of items) {
        routes[`PATCH ${itemPath(Number(checklist.id), Number(item.id))}`] = (
          body,
        ) => Response.json({ ...item, ...JSON.parse(body) });
      }
    }
    return cardStand(checklists, routes);
  }

  await t.step("по подстроке — голден и состав вызовов", async () => {
    const { io, baseUrl, seen, stop } = markStand();
    try {
      assertEquals(
        await output(kitenChecklistCheckCommand, [SELECTOR, "Тест"], io),
        await expected("check-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `PATCH ${itemPath(LIST_ID, 66835645)}`,
      ]);
      assertEquals(bodies(seen), [{ checked: true }]);
    } finally {
      await stop();
    }
  });

  await t.step("по id — голден", async () => {
    const { io, baseUrl, seen, stop } = markStand();
    try {
      assertEquals(
        await output(kitenChecklistCheckCommand, [SELECTOR, "66835647"], io),
        await expected("check-by-id-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `PATCH ${itemPath(LIST_ID, 66835647)}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("uncheck — голден и тело запроса", async () => {
    const { io, baseUrl, seen, stop } = markStand([
      goldenChecklist([
        rawItem(66835645, "Тест написан", { checked: true }),
      ]),
    ]);
    try {
      assertEquals(
        await output(kitenChecklistUncheckCommand, [SELECTOR, "Тест"], io),
        await expected("uncheck-stdout.txt", baseUrl),
      );
      assertEquals(bodies(seen), [{ checked: false }]);
    } finally {
      await stop();
    }
  });

  await t.step("повторный check печатает ту же строку", async () => {
    const { io, baseUrl, stop } = markStand();
    try {
      const first = await output(
        kitenChecklistCheckCommand,
        [SELECTOR, "Тест"],
        io,
      );
      const second = await output(
        kitenChecklistCheckCommand,
        [SELECTOR, "Тест"],
        io,
      );
      assertEquals(first, second);
      assertEquals(first, await expected("check-stdout.txt", baseUrl));
    } finally {
      await stop();
    }
  });

  await t.step("id побеждает подстроку", async () => {
    const { io, seen, stop } = markStand([
      goldenChecklist([
        rawItem(66835645, "Тест написан", { sort_order: 1 }),
        rawItem(66835646, "про пункт 66835645", { sort_order: 2 }),
      ]),
    ]);
    try {
      await output(kitenChecklistCheckCommand, [SELECTOR, "66835645"], io);
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `PATCH ${itemPath(LIST_ID, 66835645)}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("число без совпадения по id ищется подстрокой", async () => {
    const { io, seen, stop } = markStand([
      goldenChecklist([rawItem(66835645, "отчёт 12345 за июль")]),
    ]);
    try {
      await output(kitenChecklistCheckCommand, [SELECTOR, "12345"], io);
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `PATCH ${itemPath(LIST_ID, 66835645)}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("поиск сквозной: PATCH уходит в свой чек-лист", async () => {
    const { io, seen, stop } = markStand([
      goldenChecklist([rawItem(66835645, "Тест написан")]),
      {
        id: SECOND_LIST_ID,
        name: "Второй список",
        items: [rawItem(66835699, "Ревью проведено", { sort_order: 5 })],
      },
    ]);
    try {
      await output(kitenChecklistCheckCommand, [SELECTOR, "ревью"], io);
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `PATCH ${itemPath(SECOND_LIST_ID, 66835699)}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("неоднозначная ссылка: голден и ни одной мутации", async () => {
    const { io, seen, stop } = markStand();
    try {
      assertEquals(
        await errorText(
          kitenChecklistCheckCommand,
          [SELECTOR, "е"],
          io,
          UsageError,
        ),
        await golden("err-ambiguous-stderr.txt"),
      );
      assertEquals(calls(seen), [`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  await t.step("ненайденная ссылка: голден и ни одной мутации", async () => {
    const { io, seen, stop } = markStand();
    try {
      assertEquals(
        await errorText(
          kitenChecklistCheckCommand,
          [SELECTOR, "нет такого пункта"],
          io,
          UsageError,
        ),
        await golden("err-item-not-found-stderr.txt"),
      );
      assertEquals(calls(seen), [`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  await t.step("кандидаты сгруппированы по чек-листам", async () => {
    // Веса пунктов пересекаются, а фейк отдаёт чек-листы по убыванию id:
    // сквозная сортировка по карточке поставила бы «Альфа» первой, и
    // перечень разошёлся бы с блоками ls, по которым его и сверяют.
    const { io, stop } = markStand([
      {
        id: SECOND_LIST_ID,
        name: "Второй список",
        items: [rawItem(66847832, "Альфа", { sort_order: 1 })],
      },
      {
        id: LIST_ID,
        name: "Проверки",
        items: [rawItem(66835646, "Гейты зелёные", { sort_order: 2 })],
      },
    ]);
    try {
      assertEquals(
        await errorText(
          kitenChecklistCheckCommand,
          [SELECTOR, "нет такого пункта"],
          io,
          UsageError,
        ),
        "mpu kiten checklist check: пункт 'нет такого пункта' не найден; " +
          "есть: 66835646: Гейты зелёные; 66847832: Альфа\n",
      );
    } finally {
      await stop();
    }
  });

  await t.step("пунктов на карточке нет — «(пунктов нет)»", async () => {
    const { io, stop } = cardStand([]);
    try {
      assertEquals(
        await errorText(
          kitenChecklistUncheckCommand,
          [SELECTOR, "любой"],
          io,
          UsageError,
        ),
        "mpu kiten checklist uncheck: пункт 'любой' не найден; " +
          "есть: (пунктов нет)\n",
      );
    } finally {
      await stop();
    }
  });

  await t.step("текст кандидата обрезан до 60 символов", async () => {
    const long = "я".repeat(70);
    const { io, stop } = cardStand([
      goldenChecklist([rawItem(66835645, long)]),
    ]);
    try {
      assertEquals(
        await errorText(
          kitenChecklistCheckCommand,
          [SELECTOR, "нет такого"],
          io,
          UsageError,
        ),
        `mpu kiten checklist check: пункт 'нет такого' не найден; ` +
          `есть: 66835645: ${"я".repeat(60)}\n`,
      );
    } finally {
      await stop();
    }
  });

  await t.step("отказ чтения карточки — доменная ошибка", async () => {
    const { io, stop } = stand({
      [`GET ${CARD_PATH}`]: () => new Response("boom", { status: 500 }),
    });
    try {
      assertStringIncludes(
        await errorText(
          kitenChecklistCheckCommand,
          [SELECTOR, "Тест"],
          io,
          DomainError,
        ),
        "mpu kiten checklist check: kaiten error:",
      );
    } finally {
      await stop();
    }
  });

  await t.step("отказ отметки — доменная ошибка", async () => {
    const { io, stop } = cardStand([goldenChecklist()], {
      [`PATCH ${itemPath(LIST_ID, 66835645)}`]: () =>
        new Response("boom", { status: 500 }),
    });
    try {
      const text = await errorText(
        kitenChecklistCheckCommand,
        [SELECTOR, "Тест"],
        io,
        DomainError,
      );
      assertStringIncludes(text, "mpu kiten checklist check: kaiten error:");
    } finally {
      await stop();
    }
  });

  await t.step("невалидный селектор — ошибка ввода до сети", async () => {
    const { io, seen, stop } = cardStand([]);
    try {
      await assertRejects(
        () => kitenChecklistCheckCommand.invoke(["не-селектор", "Тест"], io),
        UsageError,
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });
});
