/**
 * Воркер одного репозитория: считает раздел ответа в своём потоке
 * (`node:worker_threads`).
 *
 * Тонкая оболочка над сборщиками разделов — и в этом смысл: обход
 * решает, где считать, а что считать, знают сами поверхности. Задание
 * приходит данными (`sweep.ts`), ответом уходит раздел либо описанная
 * ошибка: класс ошибки решает код выхода, и потерять его нельзя.
 */

import { parentPort } from "node:worker_threads";
import { mentionsSection } from "./mentions.ts";
import { nameSection } from "./name.ts";
import { describeError, type Job } from "./sweep.ts";

const port = parentPort;
if (port === null) {
  throw new Error("repo_worker.ts — модуль воркера, не программа");
}
port.once("message", async (job: Job) => {
  try {
    port.postMessage({ kind: "section", section: await sectionOf(job) });
  } catch (err) {
    port.postMessage({ kind: "error", error: describeError(err) });
  }
  // Порт закрыт — воркеру больше нечего ждать, и он кончается сам.
  port.close();
});

/**
 * Раздел по виду задания. Тип возврата широк намеренно: разделы у
 * поверхностей разные, а исчерпаемость держит `never` в `default`, а не
 * он.
 */
function sectionOf(job: Job): unknown {
  switch (job.kind) {
    case "name":
      return nameSection(job);
    case "mentions":
      return mentionsSection(job);
    default: {
      const unknown: never = job;
      throw new Error(`неизвестный вид задания: ${JSON.stringify(unknown)}`);
    }
  }
}
