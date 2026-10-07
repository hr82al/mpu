import { expect, it } from "vitest";
import { plainRows } from "./cache.ts";
import { thrown } from "@mpu/testing/thrown";
import { aliasPath, configValue, setAlias } from "../config/mod.ts";
import { makeFakeIo } from "./mod.ts";

it("фейк io: неожидаемое обращение падает с именем операции", () => {
  const io = makeFakeIo();
  thrown(
    () => io.launchOpener("xdg-open", "/tmp/x.xlsx"),
    Error,
    "opener must not be touched",
  );
});

it("фейк io: перечисленное тестом разрешено", async () => {
  const io = makeFakeIo({ readTextFile: () => Promise.resolve("данные") });
  expect(await io.readTextFile("/что угодно")).toBe("данные");
  expect(io.cwd()).toBe("/nowhere");
});

it("фейк кэш-БД: одна база на весь io, записи переживают вызовы", () => {
  const io = makeFakeIo();
  {
    using db = io.openCacheDb();
    // Как это делает команда: схема заводится записью, а не открытием.
    setAlias(db, "probe", "/o.xlsx", 1000);
  }
  {
    using db = io.openCacheDb();
    // Пока фабрика отдавала новую базу на каждый вызов, здесь была
    // пустота — и ни один тест этого не замечал.
    expect(aliasPath(db, "probe")).toBe("/o.xlsx");
  }
});

it("фейк кэш-БД: до записи схемы нет — как на чистой машине", () => {
  using db = makeFakeIo().openCacheDb();
  // Отсутствующая таблица равнозначна пустой (`platform/config.md`),
  // но схему создаёт только bootstrap: «чтение до записи» обязано
  // оставаться наблюдаемым.
  expect(configValue(db, "sheet.default")).toStrictEqual(undefined);
  expect(
    plainRows(db.query("SELECT name FROM sqlite_master WHERE name = 'config'")),
  ).toStrictEqual([]);
});

it("фейк кэш-БД: прерванная транзакция откатывается", () => {
  using db = makeFakeIo().openCacheDb();
  db.bootstrap();
  expect(() =>
    db.transaction(() => {
      db.execute("INSERT INTO config (key, value) VALUES ('a', 'b')");
      throw new Error("обрыв");
    }),
  ).toThrow();
  expect(plainRows(db.query("SELECT key FROM config"))).toStrictEqual([]);
});
