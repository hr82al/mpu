/**
 * Вопросы владельцу живут весь процесс ядра
 * (`docs/specs/platform/telegram-questions.md`, «Приём апдейтов»,
 * «Перезапуск»): старт сервера их запускает, остановка — останавливает.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listenLoopback } from "../testing/http.ts";
import { NO_BOT, type OwnerQuestions } from "../botquestions/mod.ts";
import type { CommandIo } from "../command/mod.ts";
import { type Launcher, MemoryLauncher } from "../worker/mod.ts";
import { FIRST_WORKER_PID, withBack } from "./testback.ts";

it("сервер запускает вопросы при старте и останавливает при остановке", async () => {
  const events: string[] = [];
  const questions: OwnerQuestions = {
    ask: NO_BOT.ask,
    post: NO_BOT.post,
    start: () => void events.push("start"),
    stop: () => {
      events.push("stop");
      return Promise.resolve();
    },
  };
  await withBack(() => {
    expect(events).toStrictEqual(["start"]);
    return Promise.resolve();
  }, { questions });
  expect(events).toStrictEqual(["start", "stop"]);
});

it("порт занят — ни вопросов, ни исполнителей, ни каталога", async () => {
  const events: string[] = [];
  const questions: OwnerQuestions = {
    ask: NO_BOT.ask,
    post: NO_BOT.post,
    start: () => void events.push("start"),
    stop: () => Promise.resolve(),
  };
  let launched = 0;
  const launcher = (io: CommandIo): Launcher => {
    const memory = new MemoryLauncher(io, FIRST_WORKER_PID, () => Date.now());
    return {
      launch: () => {
        launched++;
        return memory.launch();
      },
    };
  };
  // `withBack` заводит стенд во временном каталоге процесса. Каталог —
  // свой на время случая: файлы тестов идут параллельно, и в общем
  // `$TMPDIR` рядом появлялись бы чужие стенды.
  const ownTmp = await mkdtemp(join(tmpdir(), "mpu-"));
  const tmpBefore = process.env.TMPDIR;
  process.env.TMPDIR = ownTmp;
  const busy = createServer();
  const port = await listenLoopback(busy);
  try {
    // Отказ кода под тестом — ошибка рантайма «адрес занят»; узнаётся
    // по имени, а не по классу рантайма.
    await expect(withBack(() => Promise.resolve(), {
      port,
      questions,
      launcher,
    })).rejects.toMatchObject({ name: "AddrInUse" });
    expect(events).toStrictEqual([]);
    expect(launched, "исполнители запущены процессом без порта").toBe(0);
    expect(await readdir(ownTmp), "каталог стенда остался").toStrictEqual([]);
  } finally {
    busy.close();
    if (tmpBefore === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpBefore;
    await rm(ownTmp, { recursive: true });
  }
});
