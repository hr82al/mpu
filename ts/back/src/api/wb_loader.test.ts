/**
 * Группа `mpu api wb-loader-*` (`docs/specs/api-wb-loader.md`): формы
 * имени загрузчика, взаимоисключающие флаги, окно из `--from` и
 * неотменяемый первый шаг у `--and-load`.
 *
 * Все проверки ввода обязаны срабатывать до сети, поэтому подставной
 * сеанс здесь ещё и свидетель: там, где отказ правильный, он не должен
 * увидеть ни одного вызова.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { DomainError, UsageError } from "@mpu/command";
import { makeFakeIo } from "@mpu/command/testing";
import { openCacheDb } from "@mpu/command/store";
import type { CacheDb } from "@mpu/command";
import type { SlbackSession } from "@mpu/slback";
import {
  runBlocked,
  runConfig,
  runReset,
  runResume,
  wbLoaderResetCommand,
  wbLoaderResumeCommand,
  wbLoaderStatusCommand,
} from "./cmd_wb_loader.ts";
import {
  LOADERS,
  REASONS,
  requireLoader,
  requireSlug,
  slugOf,
  stateFromDate,
} from "./wb_loader.ts";

const SID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const OTHER_SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function sessionOf(fail?: (at: number) => boolean) {
  const sent: Sent[] = [];
  const session: SlbackSession = {
    token: () => Promise.resolve("токен"),
    call: (method, path, body) => {
      sent.push({ method, path, body });
      if (fail?.(sent.length - 1)) {
        return Promise.reject(new Error("сервер отказал"));
      }
      // Ответ несёт кабинет, о котором спрашивали: иначе перепутанную
      // пару «кабинет — ответ» не отличить от правильной.
      const filter = (body as { filter?: { sid?: string } } | undefined)
        ?.filter;
      return Promise.resolve(
        filter?.sid === undefined ? { ok: true } : { ok: true, of: filter.sid },
      );
    },
  };
  return { session, sent };
}

const VALUES: Readonly<Record<string, string>> = {
  BASE_API_URL: "https://slback.test/api",
  TOKEN_EMAIL: "kto@test",
  TOKEN_PASSWORD: "parol",
};

function envFile() {
  return {
    get: (name: string) => VALUES[name],
    require: (name: string) => {
      const value = VALUES[name];
      if (value === undefined) throw new Error(`нет ключа ${name}`);
      return value;
    },
    set: () => Promise.reject(new Error("запись env-файла не ожидается")),
    values: () => ({ ...VALUES }),
  };
}

/** Порт со взрывным кэшем: его открытие роняет вызов. */
function ioDirect() {
  return makeFakeIo({
    openCacheDb: () => {
      throw new Error("кэш открыт, хотя режим прямой");
    },
    envFile: envFile(),
  });
}

/** Кэш-БД с одним клиентом и его кабинетами. */
async function withCache(
  sids: readonly string[],
  body: (io: ReturnType<typeof makeFakeIo>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
        " is_deleted, synced_at) VALUES (777, 'sl-1', 1, 0, 0, 0)",
    );
    for (const sid of sids) {
      db.execute(
        "INSERT INTO sl_wb_sids (sid, client_id, server, synced_at)" +
          " VALUES (?, 777, 'sl-1', 0)",
        sid,
      );
    }
    await body(ioWith(db));
  } finally {
    await rm(dir, { recursive: true });
  }
}

function ioWith(db: CacheDb) {
  return makeFakeIo({
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    envFile: envFile(),
  });
}

const args = (over: Record<string, unknown>) =>
  ({
    print: false,
    "only-permanent": false,
    all: false,
    "and-load": false,
    ...over,
  }) as never;

describe("две формы имени загрузчика и подсказка на перепутанной", () => {
  it("слаг выводится из имени по одному правилу", () => {
    expect(slugOf("wbCards")).toBe("cards");
    expect(slugOf("wbAdvFullstats")).toBe("adv-fullstats");
    expect(slugOf("wbAdvNormqueryStatsByDates")).toBe(
      "adv-normquery-stats-by-dates",
    );
    // Списки закрыты и не пусты: пустой прошёл бы любую проверку.
    expect(LOADERS.length).toBe(25);
    expect(REASONS.length).toBe(17);
  });

  it("camelCase там, где ждут camelCase", () => {
    expect(requireLoader("wbCards")).toBe("wbCards");
    const err = assertThrowsUsage(() => requireLoader("cards"));
    // Оператор набрал существующую сущность не той формой — ему нужна
    // форма, а не список из двадцати пяти имён.
    expect(String(err.hint)).toContain("используй camelCase-имя: wbCards");
  });

  it("слаг там, где ждут слаг", () => {
    expect(requireSlug("cards")).toBe("cards");
    const err = assertThrowsUsage(() => requireSlug("wbCards"));
    expect(String(err.hint)).toContain("используй kebab-слаг: cards");
  });

  it("несуществующее имя — перечень допустимых", () => {
    const err = assertThrowsUsage(() => requireSlug("нет-такого"));
    expect(String(err.hint)).toContain("один из: ");
    expect(String(err.hint)).toContain("cards");
  });
});

function assertThrowsUsage(body: () => unknown): UsageError {
  try {
    body();
  } catch (err) {
    if (err instanceof UsageError) return err;
    throw err;
  }
  throw new Error("ожидался UsageError");
}

describe("config: три флага правки взаимоисключающи, и это до сети", () => {
  for (const pair of [
    ["enable", "disable"],
    ["enable", "reset"],
    ["disable", "reset"],
  ]) {
    it(pair.join(" + "), async () => {
      const { session, sent } = sessionOf();
      const err = await rejected(
        () =>
          runConfig(
            args({
              selector: SID,
              loader: "cards",
              [pair[0]]: true,
              [pair[1]]: true,
            }),
            ioDirect(),
            { session },
          ),
        UsageError,
      );
      expect(err.message).toContain("взаимоисключающи");
      // Ни одного вызова: «последний выигрывает» включил бы загрузчик
      // там, где просили выключить.
      expect(sent).toStrictEqual([]);
    });
  }

  it("без флагов — чтение", async () => {
    const { session, sent } = sessionOf();
    await runConfig(args({ selector: SID, loader: "cards" }), ioDirect(), {
      session,
    });
    expect(sent[0].method).toBe("GET");
    expect(sent[0].body).toStrictEqual(undefined);
    expect(sent[0].path).toContain(`/loaders/${SID}/cards/v1/config`);
  });

  it("включение и выключение: POST с частичной дельтой", async () => {
    for (const [flag, enabled] of [
      ["enable", true],
      ["disable", false],
    ] as const) {
      const { session, sent } = sessionOf();
      await runConfig(
        args({ selector: SID, loader: "cards", [flag]: true }),
        ioDirect(),
        { session },
      );
      expect(sent[0].method).toBe("POST");
      expect(sent[0].path).toContain(`/loaders/${SID}/cards/v1/config`);
      // Ровно один ключ: тело — частичная дельта, а не полная замена;
      // полная стёрла бы прочие настройки кабинета молча.
      expect(sent[0].body).toStrictEqual({ enabled });
      expect(Object.keys(sent[0].body as object)).toStrictEqual(["enabled"]);
    }
  });

  it("--reset — другой ПУТЬ и без тела", async () => {
    const { session, sent } = sessionOf();
    await runConfig(
      args({ selector: SID, loader: "cards", reset: true }),
      ioDirect(),
      { session },
    );
    // Сброс дельты отличается путём, а не телом: `{"reset": true}` ушёл
    // бы на общий путь неизвестным полем, и сервер молча ничего не
    // сбросил бы (снято с объекта, спека — таблица форм).
    expect(sent[0].method).toBe("POST");
    // Хвост пути — наш литерал, а не пользовательский ввод, и слэш в
    // нём остаётся разделителем: экранируются только sid и слаг.
    expect(sent[0].path).toStrictEqual(
      `/admin/wb-loader/loaders/${SID}/cards/v1/config/reset`,
    );
    expect(sent[0].body).toStrictEqual(undefined);
  });
});

it("reset: --state и --from взаимоисключающи, до сети", async () => {
  const { session, sent } = sessionOf();
  const err = await rejected(
    () =>
      runReset(
        args({
          selector: SID,
          loader: "orders",
          state: "{}",
          from: "2026-08-01",
        }),
        ioDirect(),
        { session },
      ),
    UsageError,
  );
  expect(err.message).toContain("взаимоисключающи");
  expect(sent).toStrictEqual([]);
});

describe("--from собирает состояние на день раньше указанной", () => {
  it("чистая функция", () => {
    // Загрузчик идёт вперёд по дате и начинает со следующего дня после
    // сохранённого: «с 1 августа» означает сохранить 31 июля.
    expect(stateFromDate("2026-08-01")).toStrictEqual({
      lastLoadedDate: "2026-07-31",
    });
    expect(stateFromDate("2026-01-01")).toStrictEqual({
      lastLoadedDate: "2025-12-31",
    });
    expect(stateFromDate("2026-03-01")).toStrictEqual({
      lastLoadedDate: "2026-02-28",
    });
  });

  it("и она же уходит в теле запроса", async () => {
    const { session, sent } = sessionOf();
    await runReset(
      args({ selector: SID, loader: "orders", from: "2026-08-01" }),
      ioDirect(),
      { session },
    );
    expect(sent[0].body).toStrictEqual({
      state: { lastLoadedDate: "2026-07-31" },
    });
  });

  it("негодная дата — отказ до сети", async () => {
    const { session, sent } = sessionOf();
    await expect(
      runReset(
        args({ selector: SID, loader: "orders", from: "01.08.2026" }),
        ioDirect(),
        { session },
      ),
    ).rejects.toThrow(UsageError);
    expect(sent).toStrictEqual([]);
  });
});

it("--and-load: отказ прогона не отменяет сброса", async () => {
  // Первый вызов проходит, второй падает.
  const { session, sent } = sessionOf((at) => at === 1);
  const err = await rejected(
    () =>
      runReset(
        args({ selector: SID, loader: "orders", "and-load": true }),
        ioDirect(),
        { session },
      ),
    DomainError,
  );
  // Сообщение обязано сказать, что сброс уже произошёл: иначе оператор
  // решит, что состояние прежнее, и повторит сброс.
  expect(err.message).toContain("сброс состояния прошёл");
  expect(err.message).toContain("форс-прогон не удался");
  expect(sent.length).toBe(2);
  expect(sent[0].path.endsWith("/v1/reset")).toBe(true);
  expect(sent[1].path.endsWith("/v1/load")).toBe(true);
});

it("--and-load: успех даёт оба ответа", async () => {
  const { session, sent } = sessionOf();
  const result = await runReset(
    args({ selector: SID, loader: "orders", "and-load": true }),
    ioDirect(),
    { session },
  );
  expect(sent.length).toBe(2);
  expect(result.loaded).toStrictEqual({ ok: true });
});

describe("blocked: фильтр из заданного, --server в тело не идёт", () => {
  it("пустой фильтр — вся ферма", async () => {
    const { session, sent } = sessionOf();
    await runBlocked(args({}), ioDirect(), { session });
    expect(sent[0].body).toStrictEqual({ filter: {} });
    expect(sent[0].path).toBe("/admin/wb-loader/blocked-loaders/v1/find");
  });

  it("заданное попадает, --server — нет", async () => {
    const { session, sent } = sessionOf();
    await runBlocked(
      args({
        loader: "wbCards",
        reason: "unknown_error",
        "only-permanent": true,
        sid: SID,
        server: "wb-3",
      }),
      ioDirect(),
      { session },
    );
    expect(sent[0].body).toStrictEqual({
      filter: {
        sid: SID,
        loader: "wbCards",
        reason: "unknown_error",
        only_permanent: true,
      },
    });
    // `--server` — клиентский постфильтр: в теле его быть не должно.
    expect(JSON.stringify(sent[0].body).includes("wb-3")).toBe(false);
  });

  it("негодная причина — отказ до сети", async () => {
    const { session, sent } = sessionOf();
    await expect(
      runBlocked(args({ reason: "нет-такой" }), ioDirect(), { session }),
    ).rejects.toThrow(UsageError);
    expect(sent).toStrictEqual([]);
  });
});

describe("resume: показ не мутирует, --all с именем — отказ", () => {
  it("без имени и без --all идёт find", async () => {
    const { session, sent } = sessionOf();
    await runResume(args({ selector: SID }), ioDirect(), { session });
    expect(sent[0].path).toBe("/admin/wb-loader/blocked-loaders/v1/find");
    expect(sent[0].body).toStrictEqual({ filter: { sid: SID } });
  });

  it("с именем идёт resume", async () => {
    const { session, sent } = sessionOf();
    await runResume(args({ selector: SID, loader: "wbCards" }), ioDirect(), {
      session,
    });
    expect(sent[0].path).toBe("/admin/wb-loader/blocked-loaders/v1/resume");
    expect(sent[0].body).toStrictEqual({
      filter: { sid: SID, loader: "wbCards" },
    });
  });

  it("--all вместе с именем — отказ до сети", async () => {
    const { session, sent } = sessionOf();
    const err = await rejected(
      () =>
        runResume(
          args({ selector: SID, loader: "wbCards", all: true }),
          ioDirect(),
          { session },
        ),
      UsageError,
    );
    expect(err.message).toContain("взаимоисключающи");
    expect(sent).toStrictEqual([]);
  });

  it("--all снимает всё: имени в фильтре нет", async () => {
    const { session, sent } = sessionOf();
    await runResume(args({ selector: SID, all: true }), ioDirect(), {
      session,
    });
    expect(sent[0].body).toStrictEqual({ filter: { sid: SID } });
    expect(sent[0].path.endsWith("/resume")).toBe(true);
  });
});

describe("резолв по кэшу: показ обходит все кабинеты", () => {
  it("единственный", async () => {
    await withCache([SID], async (io) => {
      const { session, sent } = sessionOf();
      const result = await runResume(args({ selector: "777" }), io, {
        session,
      });
      expect(sent.length).toBe(1);
      expect(sent[0].body).toStrictEqual({ filter: { sid: SID } });
      expect(result.entries.map((one) => one.sid)).toStrictEqual([SID]);
    });
  });

  it("несколько — показ по каждому, а не отказ", async () => {
    await withCache([SID, OTHER_SID], async (io) => {
      const { session, sent } = sessionOf();
      const result = await runResume(args({ selector: "777" }), io, {
        session,
      });
      // Спека зовёт это штатным исходом: селектор не назвал кабинет,
      // значит смотрим все.
      expect(sent.length).toBe(2);
      expect(
        sent
          .map((call) => (call.body as { filter: { sid: string } }).filter.sid)
          .sort(),
      ).toStrictEqual([SID, OTHER_SID].sort());
      // Проверяется ПАРА, а не два списка порознь: ответ каждого
      // кабинета помечен его же идентификатором, и перепутанные
      // местами пары этой проверки не пройдут.
      expect(result.entries.length).toBe(2);
      for (const entry of result.entries) {
        expect(entry.response).toStrictEqual({ ok: true, of: entry.sid });
      }
      expect(result.entries.map((one) => one.sid).sort()).toStrictEqual(
        [SID, OTHER_SID].sort(),
      );
    });
  });

  it("мутация при нескольких — отказ с требованием --sid", async () => {
    await withCache([SID, OTHER_SID], async (io) => {
      const { session, sent } = sessionOf();
      const err = await rejected(
        () =>
          runResume(args({ selector: "777", loader: "wbCards" }), io, {
            session,
          }),
        UsageError,
      );
      expect(err.message).toContain("несколько WB sid");
      expect(String(err.details)).toContain(SID);
      expect(String(err.details)).toContain(OTHER_SID);
      // Снятие блокировки по нескольким кабинетам сразу — не то, чего
      // просили; отказ до сети.
      expect(sent).toStrictEqual([]);
    });
  });

  it("печать показа — вызов на каждый кабинет", async () => {
    await withCache([SID, OTHER_SID], async (io) => {
      const { session, sent } = sessionOf();
      const result = await runResume(
        args({ selector: "777", print: true }),
        io,
        { session },
      );
      expect(sent).toStrictEqual([]);
      const text = wbLoaderResumeCommand.renderResult(result, [
        "777",
        "--print",
      ]);
      // Показанное меньше сделанного — тот же дефект, что чинили в 82.
      expect(curlCount(text)).toBe(2);
      expect(text).toContain(SID);
      expect(text).toContain(OTHER_SID);
    });
  });
});

it("--print печатает вызов и не отправляет ничего", async () => {
  const { session, sent } = sessionOf();
  const argv = [SID, "orders", "--from", "2026-08-01", "--print"];
  const result = await runReset(
    args({ selector: SID, loader: "orders", from: "2026-08-01", print: true }),
    ioDirect(),
    { session },
  );
  expect(sent).toStrictEqual([]);
  const text = wbLoaderResetCommand.renderResult(result, argv);
  expect(text).toContain("TOKEN=$(mpu api get-token)");
  expect(text).toContain(`/loaders/${SID}/orders/v1/reset`);
  expect(text).toContain('"lastLoadedDate":"2026-07-31"');
  // Живого токена в сниппете нет: строку копируют и пересылают.
  expect(text.includes("токен")).toBe(false);
  // Без `--and-load` второго вызова нет: печать показывает ту работу,
  // которую команда сделала бы, и ни строкой больше.
  expect(text.includes("/v1/load")).toBe(false);
  expect(curlCount(text)).toBe(1);
});

it("--print с --and-load печатает оба вызова по порядку", async () => {
  const { session, sent } = sessionOf();
  const argv = [SID, "orders", "--and-load", "--print"];
  const result = await runReset(
    args({ selector: SID, loader: "orders", "and-load": true, print: true }),
    ioDirect(),
    { session },
  );
  // Печать по-прежнему ничего не отправляет — обоих вызовов это тоже
  // касается.
  expect(sent).toStrictEqual([]);
  const text = wbLoaderResetCommand.renderResult(result, argv);
  // Два вызова: скопировав вывод, оператор сделает всю операцию, а не
  // половину.
  expect(curlCount(text)).toBe(2);
  const reset = text.indexOf("/v1/reset");
  const load = text.indexOf("/v1/load");
  expect(reset > 0 && load > 0).toBe(true);
  // Порядок — исполнения: сброс, затем прогон. Обратный порядок дал бы
  // прогон по несброшенному состоянию.
  expect(reset < load).toBe(true);
  // Строка получения токена одна: она подготовка, а не часть вызова.
  expect(text.split("TOKEN=$(mpu api get-token)").length - 1).toBe(1);
});

/** Сколько curl-вызовов в сниппете. */
function curlCount(text: string): number {
  return text.split("\n").filter((line) => line.startsWith("curl ")).length;
}

it("status: слаг в пути, прямой режим без кэша", async () => {
  // Через `--print`: настоящий сеанс здесь пошёл бы в сеть, а проверяем
  // мы путь, а не поход.
  const result = (await wbLoaderStatusCommand.invoke(
    [SID, "adv-fullstats", "--print"],
    ioDirect(),
  )) as { call: { path: string }; printed: boolean };
  expect(result.printed).toBe(true);
  expect(result.call.path).toStrictEqual(
    `/admin/wb-loader/loaders/${SID}/adv-fullstats/v1/status`,
  );
});
