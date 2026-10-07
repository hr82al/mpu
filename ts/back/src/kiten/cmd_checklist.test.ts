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

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
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
  return readFile(
    new URL(`testdata/kiten-checklist/${name}`, import.meta.url),
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

/** Чем отвечать на «МЕТОД путь»; пара вне таблицы — красный тест. */
type Routes = Readonly<Record<string, (body: string) => Response>>;

interface Stand {
  readonly io: CommandIo;
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly stop: () => Promise<void>;
}

async function stand(routes: Routes): Promise<Stand> {
  const fake = await startFakeKaiten((seen) => {
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
): Promise<Stand> {
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
  return seen
    .filter((request) => request.method !== "GET")
    .map((request) => JSON.parse(request.body));
}

/** Текст ошибки так, как его напечатает точка входа, с переводом строки. */
async function errorText(
  command: Command,
  argv: readonly string[],
  io: CommandIo,
  kind: typeof UsageError | typeof DomainError,
): Promise<string> {
  const err = await rejected(() => command.invoke(argv, io), kind);
  return `${formatCommandError(command.errorName, err)}\n`;
}

describe("checklist ls: сортировка, обе формы вывода и один вызов", () => {
  it("таблица — голден побайтово", async () => {
    const { io, seen, stop } = await cardStand([goldenChecklist()]);
    try {
      expect(
        await output(kitenChecklistLsCommand, [SELECTOR], io),
      ).toStrictEqual(await golden("ls-stdout.txt"));
      expect(calls(seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  it("--json — голден побайтово", async () => {
    const { io, stop } = await cardStand([goldenChecklist()]);
    try {
      expect(
        await output(kitenChecklistLsCommand, [SELECTOR, "--json"], io),
      ).toStrictEqual(await golden("ls-json-stdout.txt"));
    } finally {
      await stop();
    }
  });

  it("чек-листов нет — голден и пустой массив", async () => {
    const { io, stop } = await cardStand([]);
    try {
      expect(
        await output(kitenChecklistLsCommand, [SELECTOR], io),
      ).toStrictEqual(await golden("ls-empty-stdout.txt"));
      expect(
        await output(kitenChecklistLsCommand, [SELECTOR, "--json"], io),
      ).toBe("[]\n");
    } finally {
      await stop();
    }
  });

  it("чек-лист без пунктов — заголовок и одна шапка", async () => {
    const { io, stop } = await cardStand([
      {
        id: LIST_ID,
        name: "Пусто",
        items: [],
      },
    ]);
    try {
      expect(
        await output(kitenChecklistLsCommand, [SELECTOR], io),
      ).toStrictEqual(`Пусто · 0/0 (checklist id ${LIST_ID})\n id  ✓  text \n`);
    } finally {
      await stop();
    }
  });

  it("два чек-листа — два блока через пустую строку", async () => {
    const { io, stop } = await cardStand([
      { id: LIST_ID, name: "Первый", items: [rawItem(1, "раз")] },
      { id: SECOND_LIST_ID, name: "Второй", items: [] },
    ]);
    try {
      const text = await output(kitenChecklistLsCommand, [SELECTOR], io);
      expect(text.split("\n\n").length).toBe(2);
      expect(text).toContain(`Первый · 0/1 (checklist id ${LIST_ID})`);
      expect(text).toContain(`Второй · 0/0 (checklist id ${SECOND_LIST_ID})`);
    } finally {
      await stop();
    }
  });

  it("чек-листы в убывающем id — блоки по возрастанию", async () => {
    // Фейк отдаёт их в обратном порядке нарочно: на живой карточке они
    // шли по возрастанию сами собой, и такой прогон ничего не проверял бы.
    const { io, stop } = await cardStand([
      { id: SECOND_LIST_ID, name: "Второй", items: [rawItem(2, "два")] },
      { id: LIST_ID, name: "Первый", items: [rawItem(1, "раз")] },
    ]);
    try {
      const text = await output(kitenChecklistLsCommand, [SELECTOR], io);
      expect(
        text.split("\n").filter((line) => line.includes("checklist id")),
      ).toStrictEqual([
        `Первый · 0/1 (checklist id ${LIST_ID})`,
        `Второй · 0/1 (checklist id ${SECOND_LIST_ID})`,
      ]);
    } finally {
      await stop();
    }
  });

  it("отметка пункта видна как [x]", async () => {
    const { io, stop } = await cardStand([
      {
        id: LIST_ID,
        name: "Проверки",
        items: [rawItem(66835645, "Тест написан", { checked: true })],
      },
    ]);
    try {
      const text = await output(kitenChecklistLsCommand, [SELECTOR], io);
      expect(text).toContain("Проверки · 1/1");
      expect(text).toContain("[x]  Тест написан");
    } finally {
      await stop();
    }
  });

  it("отказ чтения карточки — доменная ошибка", async () => {
    const { io, stop } = await stand({
      [`GET ${CARD_PATH}`]: () => new Response("boom", { status: 500 }),
    });
    try {
      expect(
        await errorText(kitenChecklistLsCommand, [SELECTOR], io, DomainError),
      ).toContain("mpu kiten checklist ls: kaiten error:");
    } finally {
      await stop();
    }
  });

  it("пункт без sort_order идёт как с нулевым", async () => {
    const { io, stop } = await cardStand([
      {
        id: LIST_ID,
        name: "Проверки",
        items: [
          rawItem(2, "второй", { sort_order: 1 }),
          rawItem(1, "первый", { sort_order: undefined }),
        ],
      },
    ]);
    try {
      const text = await output(kitenChecklistLsCommand, [SELECTOR], io);
      const ids = text
        .split("\n")
        .slice(2, 4)
        .map((line) => line.trim().split(/\s+/)[0]);
      expect(ids).toStrictEqual(["1", "2"]);
    } finally {
      await stop();
    }
  });
});

describe("checklist add: создание, идемпотентность и sort_order", () => {
  it("чек-листа нет — создан, два пункта", async () => {
    const { io, baseUrl, seen, stop } = await cardStand([], {
      [`POST ${CHECKLISTS_PATH}`]: () =>
        Response.json({ id: LIST_ID, name: "Проверки", items: [] }),
      [`POST ${itemsPath(LIST_ID)}`]: (body) =>
        Response.json({ id: 66835645, ...JSON.parse(body) }),
    });
    try {
      expect(
        await output(
          kitenChecklistAddCommand,
          [
            SELECTOR,
            "-n",
            "Проверки",
            "-i",
            "Тест написан",
            "-i",
            "Гейты зелёные",
          ],
          io,
        ),
      ).toStrictEqual(await expected("add-created-stdout.txt", baseUrl));
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `POST ${CHECKLISTS_PATH}`,
        `POST ${itemsPath(LIST_ID)}`,
        `POST ${itemsPath(LIST_ID)}`,
      ]);
      expect(bodies(seen)).toStrictEqual([
        { name: "Проверки" },
        { text: "Тест написан", checked: false, sort_order: 1 },
        { text: "Гейты зелёные", checked: false, sort_order: 2 },
      ]);
    } finally {
      await stop();
    }
  });

  it("чек-лист существует — пункта создания нет", async () => {
    const existing = goldenChecklist([
      rawItem(66835645, "Тест написан", { sort_order: 1 }),
      rawItem(66835646, "Гейты зелёные", { sort_order: 2 }),
    ]);
    const { io, baseUrl, seen, stop } = await cardStand([existing], {
      [`POST ${itemsPath(LIST_ID)}`]: (body) =>
        Response.json({ id: 66835647, ...JSON.parse(body) }),
    });
    try {
      expect(
        await output(
          kitenChecklistAddCommand,
          [
            SELECTOR,
            "-n",
            "Проверки",
            "-i",
            "Тест написан",
            "-i",
            "Третий пункт",
          ],
          io,
        ),
      ).toStrictEqual(await expected("add-existing-stdout.txt", baseUrl));
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `POST ${itemsPath(LIST_ID)}`,
      ]);
      // Пропущенный текст номер всё равно занял: у нового пункта
      // максимум (2) плюс порядковый номер его флага (2).
      expect(bodies(seen)).toStrictEqual([
        { text: "Третий пункт", checked: false, sort_order: 4 },
      ]);
    } finally {
      await stop();
    }
  });

  it("без -i — чек-лист создан, добавлено 0", async () => {
    const { io, baseUrl, seen, stop } = await cardStand([], {
      [`POST ${CHECKLISTS_PATH}`]: () =>
        Response.json({ id: SECOND_LIST_ID, name: "Второй список", items: [] }),
    });
    try {
      expect(
        await output(
          kitenChecklistAddCommand,
          [SELECTOR, "-n", "Второй список"],
          io,
        ),
      ).toStrictEqual(await expected("add-name-only-stdout.txt", baseUrl));
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `POST ${CHECKLISTS_PATH}`,
      ]);
    } finally {
      await stop();
    }
  });

  it("все тексты уже есть — ни одного POST пункта", async () => {
    const { io, seen, stop } = await cardStand([goldenChecklist()]);
    try {
      const text = await output(
        kitenChecklistAddCommand,
        [
          SELECTOR,
          "-n",
          "Проверки",
          "-i",
          "Тест написан",
          "-i",
          "Третий пункт",
        ],
        io,
      );
      expect(text).toContain("(существующий, id 11960707)");
      expect(text).toContain("добавлено пунктов: 0");
      expect(calls(seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  it("повтор текста внутри вызова — один пункт", async () => {
    const { io, seen, stop } = await cardStand([], {
      [`POST ${CHECKLISTS_PATH}`]: () =>
        Response.json({ id: LIST_ID, name: "Проверки", items: [] }),
      [`POST ${itemsPath(LIST_ID)}`]: (body) =>
        Response.json({ id: 66835645, ...JSON.parse(body) }),
    });
    try {
      const text = await output(
        kitenChecklistAddCommand,
        [
          SELECTOR,
          "-n",
          "Проверки",
          "-i",
          "Тест написан",
          "-i",
          "Тест написан",
        ],
        io,
      );
      expect(text).toContain("добавлено пунктов: 1");
      expect(bodies(seen)).toStrictEqual([
        { name: "Проверки" },
        { text: "Тест написан", checked: false, sort_order: 1 },
      ]);
    } finally {
      await stop();
    }
  });

  it("отказ на середине списка называет число", async () => {
    let posted = 0;
    const { io, stop } = await cardStand([], {
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
      expect(text).toContain("mpu kiten checklist add: kaiten error:");
      expect(text).toContain("добавлено пунктов: 1");
    } finally {
      await stop();
    }
  });

  it("одноимённые чек-листы — берётся меньший id", async () => {
    // Фейк отдаёт их по убыванию id: выбор «первый в ответе сервера»
    // взял бы больший и упёрся бы в незаданный маршрут его пунктов.
    const { io, seen, stop } = await cardStand(
      [
        { id: SECOND_LIST_ID, name: "Проверки", items: [] },
        { id: LIST_ID, name: "Проверки", items: [] },
      ],
      {
        [`POST ${itemsPath(LIST_ID)}`]: (body) =>
          Response.json({ id: 66835645, ...JSON.parse(body) }),
      },
    );
    try {
      const text = await output(
        kitenChecklistAddCommand,
        [SELECTOR, "-n", "Проверки", "-i", "Тест написан"],
        io,
      );
      expect(text).toContain(`(существующий, id ${LIST_ID})`);
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `POST ${itemsPath(LIST_ID)}`,
      ]);
    } finally {
      await stop();
    }
  });

  it("без --name — ошибка ввода до сети", async () => {
    const { io, seen, stop } = await cardStand([]);
    try {
      await expect(
        kitenChecklistAddCommand.invoke([SELECTOR], io),
      ).rejects.toThrow(UsageError);
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });

  it("отказ чтения карточки — доменная ошибка", async () => {
    const { io, stop } = await stand({
      [`GET ${CARD_PATH}`]: () => new Response("boom", { status: 500 }),
    });
    try {
      const text = await errorText(
        kitenChecklistAddCommand,
        [SELECTOR, "-n", "Проверки"],
        io,
        DomainError,
      );
      expect(text).toContain("mpu kiten checklist add: kaiten error:");
    } finally {
      await stop();
    }
  });
});

describe("checklist check/uncheck: резолв пункта и один PATCH", () => {
  /** Стенд карточки голденов с ответом отметки. */
  function markStand(
    checklists: readonly Record<string, unknown>[] = [goldenChecklist()],
  ): Promise<Stand> {
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

  it("по подстроке — голден и состав вызовов", async () => {
    const { io, baseUrl, seen, stop } = await markStand();
    try {
      expect(
        await output(kitenChecklistCheckCommand, [SELECTOR, "Тест"], io),
      ).toStrictEqual(await expected("check-stdout.txt", baseUrl));
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `PATCH ${itemPath(LIST_ID, 66835645)}`,
      ]);
      expect(bodies(seen)).toStrictEqual([{ checked: true }]);
    } finally {
      await stop();
    }
  });

  it("по id — голден", async () => {
    const { io, baseUrl, seen, stop } = await markStand();
    try {
      expect(
        await output(kitenChecklistCheckCommand, [SELECTOR, "66835647"], io),
      ).toStrictEqual(await expected("check-by-id-stdout.txt", baseUrl));
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `PATCH ${itemPath(LIST_ID, 66835647)}`,
      ]);
    } finally {
      await stop();
    }
  });

  it("uncheck — голден и тело запроса", async () => {
    const { io, baseUrl, seen, stop } = await markStand([
      goldenChecklist([rawItem(66835645, "Тест написан", { checked: true })]),
    ]);
    try {
      expect(
        await output(kitenChecklistUncheckCommand, [SELECTOR, "Тест"], io),
      ).toStrictEqual(await expected("uncheck-stdout.txt", baseUrl));
      expect(bodies(seen)).toStrictEqual([{ checked: false }]);
    } finally {
      await stop();
    }
  });

  it("повторный check печатает ту же строку", async () => {
    const { io, baseUrl, stop } = await markStand();
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
      expect(first).toStrictEqual(second);
      expect(first).toStrictEqual(await expected("check-stdout.txt", baseUrl));
    } finally {
      await stop();
    }
  });

  it("id побеждает подстроку", async () => {
    const { io, seen, stop } = await markStand([
      goldenChecklist([
        rawItem(66835645, "Тест написан", { sort_order: 1 }),
        rawItem(66835646, "про пункт 66835645", { sort_order: 2 }),
      ]),
    ]);
    try {
      await output(kitenChecklistCheckCommand, [SELECTOR, "66835645"], io);
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `PATCH ${itemPath(LIST_ID, 66835645)}`,
      ]);
    } finally {
      await stop();
    }
  });

  it("число без совпадения по id ищется подстрокой", async () => {
    const { io, seen, stop } = await markStand([
      goldenChecklist([rawItem(66835645, "отчёт 12345 за июль")]),
    ]);
    try {
      await output(kitenChecklistCheckCommand, [SELECTOR, "12345"], io);
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `PATCH ${itemPath(LIST_ID, 66835645)}`,
      ]);
    } finally {
      await stop();
    }
  });

  it("поиск сквозной: PATCH уходит в свой чек-лист", async () => {
    const { io, seen, stop } = await markStand([
      goldenChecklist([rawItem(66835645, "Тест написан")]),
      {
        id: SECOND_LIST_ID,
        name: "Второй список",
        items: [rawItem(66835699, "Ревью проведено", { sort_order: 5 })],
      },
    ]);
    try {
      await output(kitenChecklistCheckCommand, [SELECTOR, "ревью"], io);
      expect(calls(seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `PATCH ${itemPath(SECOND_LIST_ID, 66835699)}`,
      ]);
    } finally {
      await stop();
    }
  });

  it("неоднозначная ссылка: голден и ни одной мутации", async () => {
    const { io, seen, stop } = await markStand();
    try {
      expect(
        await errorText(
          kitenChecklistCheckCommand,
          [SELECTOR, "е"],
          io,
          UsageError,
        ),
      ).toStrictEqual(await golden("err-ambiguous-stderr.txt"));
      expect(calls(seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  it("ненайденная ссылка: голден и ни одной мутации", async () => {
    const { io, seen, stop } = await markStand();
    try {
      expect(
        await errorText(
          kitenChecklistCheckCommand,
          [SELECTOR, "нет такого пункта"],
          io,
          UsageError,
        ),
      ).toStrictEqual(await golden("err-item-not-found-stderr.txt"));
      expect(calls(seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  it("кандидаты сгруппированы по чек-листам", async () => {
    // Веса пунктов пересекаются, а фейк отдаёт чек-листы по убыванию id:
    // сквозная сортировка по карточке поставила бы «Альфа» первой, и
    // перечень разошёлся бы с блоками ls, по которым его и сверяют.
    const { io, stop } = await markStand([
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
      expect(
        await errorText(
          kitenChecklistCheckCommand,
          [SELECTOR, "нет такого пункта"],
          io,
          UsageError,
        ),
      ).toStrictEqual(
        "mpu kiten checklist check: пункт 'нет такого пункта' не найден; " +
          "есть: 66835646: Гейты зелёные; 66847832: Альфа\n",
      );
    } finally {
      await stop();
    }
  });

  it("пунктов на карточке нет — «(пунктов нет)»", async () => {
    const { io, stop } = await cardStand([]);
    try {
      expect(
        await errorText(
          kitenChecklistUncheckCommand,
          [SELECTOR, "любой"],
          io,
          UsageError,
        ),
      ).toStrictEqual(
        "mpu kiten checklist uncheck: пункт 'любой' не найден; " +
          "есть: (пунктов нет)\n",
      );
    } finally {
      await stop();
    }
  });

  it("текст кандидата обрезан до 60 символов", async () => {
    const long = "я".repeat(70);
    const { io, stop } = await cardStand([
      goldenChecklist([rawItem(66835645, long)]),
    ]);
    try {
      expect(
        await errorText(
          kitenChecklistCheckCommand,
          [SELECTOR, "нет такого"],
          io,
          UsageError,
        ),
      ).toStrictEqual(
        `mpu kiten checklist check: пункт 'нет такого' не найден; ` +
          `есть: 66835645: ${"я".repeat(60)}\n`,
      );
    } finally {
      await stop();
    }
  });

  it("отказ чтения карточки — доменная ошибка", async () => {
    const { io, stop } = await stand({
      [`GET ${CARD_PATH}`]: () => new Response("boom", { status: 500 }),
    });
    try {
      expect(
        await errorText(
          kitenChecklistCheckCommand,
          [SELECTOR, "Тест"],
          io,
          DomainError,
        ),
      ).toContain("mpu kiten checklist check: kaiten error:");
    } finally {
      await stop();
    }
  });

  it("отказ отметки — доменная ошибка", async () => {
    const { io, stop } = await cardStand([goldenChecklist()], {
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
      expect(text).toContain("mpu kiten checklist check: kaiten error:");
    } finally {
      await stop();
    }
  });

  it("пустая ссылка — ошибка ввода до сети", async () => {
    // Пустая подстрока совпала бы со всем: на карточке с единственным
    // пунктом это ровно одно совпадение, то есть мутация по мусорному
    // входу (`kiten-checklist.md`, «Граничные случаи»).
    for (const ref of ["", "   "]) {
      const { io, seen, stop } = await markStand();
      try {
        expect(
          await errorText(
            kitenChecklistUncheckCommand,
            [SELECTOR, ref],
            io,
            UsageError,
          ),
        ).toStrictEqual(
          "mpu kiten checklist uncheck: пустая ссылка на пункт; ожидается " +
            "id пункта или подстрока его текста\n",
        );
        expect(calls(seen)).toStrictEqual([]);
      } finally {
        await stop();
      }
    }
  });

  it("невалидный селектор — ошибка ввода до сети", async () => {
    const { io, seen, stop } = await cardStand([]);
    try {
      await expect(
        kitenChecklistCheckCommand.invoke(["не-селектор", "Тест"], io),
      ).rejects.toThrow(UsageError);
      expect(calls(seen)).toStrictEqual([]);
    } finally {
      await stop();
    }
  });
});
