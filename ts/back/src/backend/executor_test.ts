/**
 * Строка на исполнителе (`platform/line-executor.md`): смерть
 * исполнителя — отказ этой строки, а не падение ядра. Исполнители — в
 * памяти теста; «сторож» — сам тест: пишет отметку и убивает
 * исполнителя, пока строка ждёт ответа на свой вопрос.
 */

import { assertEquals } from "@std/assert";
import {
  Client,
  FIRST_WORKER_PID,
  type Frame,
  line,
  request,
  withBack,
} from "./testback.ts";
import type { TestBack } from "./testback.ts";

/** Строка `confirm`, повисшая на вопросе, и её исполнитель. */
async function asking(
  back: TestBack,
): Promise<{ client: Client; pid: number }> {
  const client = new Client(back, "/line");
  await client.opened();
  client.send({
    words: ["confirm"],
    cwd: Deno.cwd(),
    human: true,
    stdin: "данные\n",
  });
  await client.frame((frame) => "ask" in frame);
  // Строка взяла первого тёплого исполнителя: он и занят.
  const [busy] = back.launcher.launched();
  return { client, pid: busy.pid };
}

function killed(back: TestBack, pid: number) {
  const spawned = back.launcher.launched().find((one) => one.pid === pid);
  spawned?.kill("SIGKILL");
}

/** Кадры строки после её вопроса. */
function tail(frames: readonly Frame[]): Frame[] {
  return frames.slice(frames.findIndex((frame) => "ask" in frame) + 1);
}

Deno.test("исполнителя убил сторож: отказ строки с размером, ядро и соседняя строка живы", () =>
  withBack(async (back) => {
    const { client, pid } = await asking(back);
    // Соседняя строка идёт, пока первая ждёт ответа.
    const neighbour = await line(back, "/line", ["jsdate"]);
    assertEquals(neighbour.at(-1), { exit: 0 });
    await Deno.mkdir(back.markersDir, { recursive: true });
    await Deno.writeTextFile(`${back.markersDir}/${pid}`, "900\n");
    killed(back, pid);
    assertEquals(tail(await client.finished()), [
      {
        err: "mpu-back: строка остановлена: машине не хватает памяти, " +
          "строка заняла 900 МиБ\n",
      },
      { exit: 1 },
    ]);
    const health = await request(back, "/health");
    assertEquals(health.status, 200);
    assertEquals(JSON.parse(health.body).pid, Deno.pid);
    // После смерти — снова строка: пул жив.
    assertEquals((await line(back, "/line", ["jsdate"])).at(-1), { exit: 0 });
  }));

Deno.test("исполнитель умер сигналом без отметки: «упал (сигнал 9)», код 1", () =>
  withBack(async (back) => {
    const { client, pid } = await asking(back);
    killed(back, pid);
    assertEquals(tail(await client.finished()), [
      { err: "mpu-back: исполнитель строки упал (сигнал 9)\n" },
      { exit: 1 },
    ]);
  }));

Deno.test("запись журнала строки называет pid исполнителя, а не ядра", () =>
  withBack(async (back) => {
    assertEquals((await line(back, "/line", ["jsdate"])).at(-1), { exit: 0 });
    assertEquals(back.executors, [FIRST_WORKER_PID]);
    assertEquals(back.executors.includes(Deno.pid), false);
  }));
