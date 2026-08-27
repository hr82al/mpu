/**
 * Команда `mpu mr files` (`docs/specs/mr-read.md`): изменённые файлы
 * MR со счётчиками строк.
 *
 * Счётчики считает разбор диффа, а не поля ответа: у GitLab их в
 * `/changes` нет вовсе, и «сколько строк тронуто» приходится выводить
 * из самого диффа (`platform/gitlab-api.md`).
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { type ChangedFile, changedFiles } from "../gitlab/mod.ts";
import { renderTable } from "../ps/table.ts";
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
  json: z.boolean().default(false).describe("массив объектов JSON"),
});

const fileSchema = z.object({
  status: z.enum(["A", "D", "R", "M"]),
  old_path: z.string(),
  new_path: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

const resultSchema = z.object({
  files: z.array(fileSchema).describe("файлы в порядке ответа API"),
});

type FilesArgs = z.infer<typeof argsSchema>;
type FilesResult = z.infer<typeof resultSchema>;
type FileRow = z.infer<typeof fileSchema>;

/** Ход вызова: резолв адреса, затем `/changes` одним ответом. */
export async function runFiles(
  args: FilesArgs,
  io: MrIo,
  options: MrOptions = {},
): Promise<FilesResult> {
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  let files: readonly ChangedFile[];
  try {
    files = await changedFiles(access, address);
  } catch (err) {
    throw asCommandError(io, err);
  }
  return { files: files.map(rowOf) };
}

/** Строка результата: дифф в вывод не идёт, только его счётчики. */
function rowOf(file: ChangedFile): FileRow {
  return {
    status: file.status,
    old_path: file.old_path,
    new_path: file.new_path,
    additions: file.additions,
    deletions: file.deletions,
  };
}

/** Имя файла в таблице; переименование показывается обоими путями. */
export function fileLabel(file: FileRow): string {
  const target = file.new_path === "" ? file.old_path : file.new_path;
  return file.status === "R" && file.old_path !== "" &&
      file.old_path !== file.new_path
    ? `${file.old_path} → ${file.new_path}`
    : target;
}

/** Таблица с хвостом-суммой; `--json` — тот же порядок файлов. */
export function renderFiles(result: FilesResult, json: boolean): string {
  if (json) return `${JSON.stringify(result.files, null, 2)}\n`;
  const rows = result.files.map((file) => [
    file.status,
    `+${file.additions}`,
    `-${file.deletions}`,
    fileLabel(file),
  ]);
  const table = renderTable(["ST", "+", "-", "FILE"], rows);
  const additions = result.files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = result.files.reduce((sum, f) => sum + f.deletions, 0);
  return `${table}(${result.files.length} files, ` +
    `+${additions} / -${deletions})\n`;
}

export const mrFilesCommand = defineCommand({
  path: ["mr", "files"],
  errorName: "mr files",
  summary: "Изменённые файлы merge request'а со счётчиками строк.",
  usage: "mpu mr files [--mr REF] [--json]",
  help: `Таблица изменённых файлов: ST — статус (A новый, D удалённый,
R переименованный, M изменённый), затем добавленные и удалённые строки
и путь файла. Переименование показано как 'старый → новый'. Последняя
строка — сумма по всем файлам.

Счётчики строк считаются из самого диффа: в ответе GitLab их нет.
У binary-файла дифф пуст, поэтому у него +0 / -0.

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid; без флага —
открытый MR текущей ветки.

--json печатает массив объектов {status, old_path, new_path, additions,
deletions} в том же порядке, что и таблица.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех, в том числе у MR без изменённых файлов; 2 —
нераспознанный --mr; 1 — отказ GitLab, ненайденный MR.

Примеры: mpu mr files; mpu mr files --mr 456 --json`,
  policy: "ro",
  argsSchema,
  resultSchema,
  run: (args: FilesArgs, io: MrIo) => runFiles(args, io),
  render: (result: FilesResult, args: FilesArgs) =>
    renderFiles(result, args.json),
});
