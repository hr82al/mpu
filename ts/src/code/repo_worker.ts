/// <reference lib="deno.worker" />
/**
 * Воркер одного репозитория: считает раздел ответа в своём потоке.
 *
 * Тонкая оболочка над сборщиками разделов — и в этом смысл: обход
 * решает, где считать, а что считать, знают сами поверхности. Задание
 * приходит данными (`sweep.ts`), ответом уходит раздел либо описанная
 * ошибка: класс ошибки решает код выхода, и потерять его нельзя.
 *
 * Директива `reference lib` обязательна: без неё `self` типизируется
 * как окно, а не как область воркера, и `postMessage` не существует.
 */

import { mentionsSection } from "./mentions.ts";
import { nameSection } from "./name.ts";
import { describeError, type Job } from "./sweep.ts";

self.onmessage = async (event: MessageEvent<Job>) => {
  try {
    self.postMessage({ kind: "section", section: await sectionOf(event.data) });
  } catch (err) {
    self.postMessage({ kind: "error", error: describeError(err) });
  }
  self.close();
};

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
