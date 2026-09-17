import { assertEquals, assertThrows } from "@std/assert";
import { aliasPath, configValue, setAlias } from "../config/mod.ts";
import { makeFakeIo } from "./mod.ts";

Deno.test("фейк io: неожидаемое обращение падает с именем операции", () => {
  const io = makeFakeIo();
  assertThrows(
    () => io.launchOpener("xdg-open", "/tmp/x.xlsx"),
    Error,
    "opener must not be touched",
  );
});

Deno.test("фейк io: перечисленное тестом разрешено", async () => {
  const io = makeFakeIo({ readTextFile: () => Promise.resolve("данные") });
  assertEquals(await io.readTextFile("/что угодно"), "данные");
  assertEquals(io.cwd(), "/nowhere");
});

Deno.test("фейк кэш-БД: одна база на весь io, записи переживают вызовы", () => {
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
    assertEquals(aliasPath(db, "probe"), "/o.xlsx");
  }
});

Deno.test("фейк кэш-БД: до записи схемы нет — как на чистой машине", () => {
  using db = makeFakeIo().openCacheDb();
  // Отсутствующая таблица равнозначна пустой (`platform/config.md`),
  // но схему создаёт только bootstrap: «чтение до записи» обязано
  // оставаться наблюдаемым.
  assertEquals(configValue(db, "sheet.default"), undefined);
  assertEquals(
    db.query("SELECT name FROM sqlite_master WHERE name = 'config'"),
    [],
  );
});

Deno.test("фейк кэш-БД: прерванная транзакция откатывается", () => {
  using db = makeFakeIo().openCacheDb();
  db.bootstrap();
  assertThrows(() =>
    db.transaction(() => {
      db.execute("INSERT INTO config (key, value) VALUES ('a', 'b')");
      throw new Error("обрыв");
    })
  );
  assertEquals(db.query("SELECT key FROM config"), []);
});
