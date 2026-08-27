/**
 * Команда `mpu mr diff` (`docs/specs/mr-read.md`): unified diff MR
 * блоками по файлам.
 *
 * Фильтр `--file` — подстрока по обоим путям, а не по одному: у
 * переименованного файла оператор помнит любой из них, и промах по
 * старому имени выглядел бы как «в MR этого файла нет».
 */

import { z } from "@zod/zod";
import { defineCommand, DomainError } from "../command/mod.ts";
import { type ChangedFile, changedFiles } from "../gitlab/mod.ts";
import {
  asCommandError,
  gitlabAccess,
  mrAddress,
  type MrIo,
  type MrOptions,
} from "./common.ts";

const argsSchema = z.object({
  mr: z.string().optional().describe(
    "MR: URL | 'group/repo!iid' | iid; без флага — открытый MR ветки",
  ),
  file: z.string().optional().describe(
    "подстрока пути: только файлы, чей старый или новый путь её содержит",
  ),
  json: z.boolean().default(false).describe("массив объектов JSON"),
});

const fileSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  diff: z.string(),
  new_file: z.boolean(),
  renamed_file: z.boolean(),
  deleted_file: z.boolean(),
});

const resultSchema = z.object({
  files: z.array(fileSchema).describe("файлы после фильтра, в порядке ответа"),
});

type DiffArgs = z.infer<typeof argsSchema>;
type DiffResult = z.infer<typeof resultSchema>;
type DiffFile = z.infer<typeof fileSchema>;

/** Ход вызова: `/changes`, затем фильтр по подстроке пути. */
export async function runDiff(
  args: DiffArgs,
  io: MrIo,
  options: MrOptions = {},
): Promise<DiffResult> {
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  let files: readonly ChangedFile[];
  try {
    files = await changedFiles(access, address);
  } catch (err) {
    throw asCommandError(io, err);
  }
  const selected = args.file === undefined
    ? files
    : files.filter((file) =>
      file.new_path.includes(args.file as string) ||
      file.old_path.includes(args.file as string)
    );
  if (selected.length === 0 && args.file !== undefined) {
    // Отказ, а не пустой вывод: подстрока набрана человеком, и молчание
    // здесь неотличимо от «файл не менялся».
    throw new DomainError(
      `нет изменённых файлов по подстроке '${args.file}'`,
    );
  }
  return { files: selected.map(fileOf) };
}

function fileOf(file: ChangedFile): DiffFile {
  return {
    old_path: file.old_path,
    new_path: file.new_path,
    diff: file.diff,
    new_file: file.new_file,
    renamed_file: file.renamed_file,
    deleted_file: file.deleted_file,
  };
}

/** Суффикс заголовка блока: что случилось с файлом целиком. */
function suffixOf(file: DiffFile): string {
  if (file.new_file) return "  [new file]";
  if (file.deleted_file) return "  [deleted file]";
  if (file.renamed_file) return "  [renamed]";
  return "";
}

/** Блоки по файлам через пустую строку; `--json` — те же файлы. */
export function renderDiff(result: DiffResult, json: boolean): string {
  if (json) return `${JSON.stringify(result.files, null, 2)}\n`;
  if (result.files.length === 0) return "(MR без изменённых файлов)\n";
  const blocks = result.files.map((file) => {
    const header = `diff --git a/${file.old_path} b/${file.new_path}` +
      suffixOf(file);
    // Пустой дифф — binary-файл: сказать об этом прямо дешевле, чем
    // заставлять оператора гадать, почему блок пуст.
    const body = file.diff.replace(/\n+$/, "");
    return body === ""
      ? `${header}\n(binary / без текстового диффа)`
      : `${header}\n${body}`;
  });
  return `${blocks.join("\n\n")}\n`;
}

export const mrDiffCommand = defineCommand({
  path: ["mr", "diff"],
  errorName: "mr diff",
  summary: "Unified diff merge request'а блоками по файлам.",
  usage: "mpu mr diff [--mr REF] [--file SUBSTR] [--json]",
  help: `Печатает дифф MR блоками: заголовок 'diff --git a/… b/…' и тело
диффа под ним, блоки разделены пустой строкой. У нового, удалённого и
переименованного файла заголовок несёт пометку [new file], [deleted
file] или [renamed]. Binary-файл печатается как '(binary / без
текстового диффа)'.

--file SUBSTR оставляет только файлы, чей новый ИЛИ старый путь
содержит подстроку; переименованный файл находится по любому из имён.
Ни одного совпадения — отказ, а не пустой вывод.

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid; без флага —
открытый MR текущей ветки.

--json печатает массив объектов {old_path, new_path, diff, new_file,
renamed_file, deleted_file} — уже после фильтра.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех, в том числе у MR без изменённых файлов; 2 —
нераспознанный --mr; 1 — отказ GitLab, ненайденный MR, пустой результат
фильтра --file.

Примеры: mpu mr diff; mpu mr diff --file loader.ts --mr 456`,
  policy: "ro",
  argsSchema,
  resultSchema,
  run: (args: DiffArgs, io: MrIo) => runDiff(args, io),
  render: (result: DiffResult, args: DiffArgs) => renderDiff(result, args.json),
});
