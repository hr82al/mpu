/**
 * Команда `mpu image export` в дереве (`image-export.md`, «CLI-контракт»):
 * справка, ключ `dir:` и политика. Исполняет строку ядро, как `image sync`
 * (`line/sync.ts`): решение по методу то же, применяется только база →
 * файлы.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";

/** Путь команды: по нему ядро узнаёт строку выгрузки. */
export const EXPORT_PATH: readonly string[] = ["image", "export"];

/** Аргументы строки `image export` после разбора цепочкой. */
export const exportArgsSchema = z.object({
  dir: z.string().optional().describe(
    "каталог файлов; умолчание — ключ конфига image.dir",
  ),
});

/** Аргументы выгрузки. */
export type ExportArgs = z.infer<typeof exportArgsSchema>;

const resultSchema = z.object({
  report: z.string().describe("текст отчёта: строка на метод и итог"),
});

export const imageExportCommand = defineCommand({
  path: EXPORT_PATH,
  keys: {},
  errorName: "image export",
  summary: "Пишет в файлы каталога образа то, что изменилось в базе.",
  usage: "mpu image export [dir: КАТАЛОГ]",
  help: `Её зовёт суточный таймер; человеку — когда нужны файлы без \
вопроса: пишет только в каталог образа, а всё, что меняет базу, оставляет \
строкой «ждёт человека» для image sync.

Решение по методу — как у image sync. Применяется только база → файлы:
новый файл, файл из базы, удалён файл. База из файла, новый метод, удалён
метод и конфликт — строка ждёт человека<TAB>действие<TAB>получатель имя
(у конфликт — четвёртым полем адрес); ни база, ни её правила, ни архив
по такому методу не меняются.

dir: — каталог; умолчание — mpu config key: image.dir. Только
$HOME/mr/mp/mpu/image или под ним.

stdout — строки как у image sync и строки ждёт человека, последней —
совпало N, изменено M, конфликтов K (ждёт человека ни в одно число не
входит). Результат — текст.

Exit: 1 — сбой или неразобранный файл; 2 — строка набрана не так,
каталог вне права или удалилось бы больше половины файлов (совет —
mpu ask image sync deletes: allow). Строка ждёт человека кода не меняет.`,
  examples: ["mpu image export"],
  policy: "rw",
  text: true,
  argsSchema: exportArgsSchema,
  resultSchema,
  run: () =>
    Promise.reject(
      new Error("строку image export исполняет ядро, не исполнитель"),
    ),
  render: (result) => result.report,
});
