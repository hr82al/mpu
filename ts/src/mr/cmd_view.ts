/**
 * Команда `mpu mr view` (`docs/specs/mr-read.md`): шапка MR.
 *
 * Самая дешёвая подкоманда семейства: один GET, ни диффа, ни тредов.
 * Ею же проверяется доступность MR перед долгими вызовами.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { mergeRequest } from "../gitlab/mod.ts";
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
  json: z.boolean().default(false).describe("объект MR целиком"),
});

const diffRefsSchema = z.object({
  base_sha: z.string(),
  start_sha: z.string(),
  head_sha: z.string(),
});

const resultSchema = z.object({
  project: z.string(),
  iid: z.number(),
  title: z.string(),
  state: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  web_url: z.string(),
  author_name: z.string(),
  author_username: z.string(),
  description: z.string(),
  diff_refs: z.union([diffRefsSchema, z.null()]),
  project_id: z.union([z.number(), z.null()]),
  sha: z.union([z.string(), z.null()]),
  merge_commit_sha: z.union([z.string(), z.null()]),
  squash_commit_sha: z.union([z.string(), z.null()]),
});

type ViewArgs = z.infer<typeof argsSchema>;
type ViewResult = z.infer<typeof resultSchema>;

/** Ход вызова: резолв адреса, затем один GET шапки. */
export async function runView(
  args: ViewArgs,
  io: MrIo,
  options: MrOptions = {},
): Promise<ViewResult> {
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  try {
    return await mergeRequest(access, address);
  } catch (err) {
    throw asCommandError(io, err);
  }
}

/** Заголовок MR одной строкой; он же открывает вывод `comments`. */
export function mrHeadline(mr: {
  project: string;
  iid: number;
  title: string;
  state: string;
}): string {
  return `MR ${mr.project}!${mr.iid} — ${mr.title} [${mr.state}]`;
}

/** Четыре строки шапки и описание под ними. */
export function renderView(mr: ViewResult, json: boolean): string {
  if (json) return `${JSON.stringify(mr, null, 2)}\n`;
  const author = mr.author_name === "" ? mr.author_username : mr.author_name;
  const head = [
    mrHeadline(mr),
    `author: ${author} (@${mr.author_username})`,
    `branch: ${mr.source_branch} → ${mr.target_branch}`,
    `url:    ${mr.web_url}`,
  ].join("\n");
  // Хвостовые переводы строки описания срезаются: у описания из
  // веб-формы их бывает сколько угодно, и вывод «плавал» бы по высоте.
  const description = mr.description.replace(/\n+$/, "");
  return description === "" ? `${head}\n` : `${head}\n\n${description}\n`;
}

export const mrViewCommand = defineCommand({
  path: ["mr", "view"],
  errorName: "mr view",
  summary: "Шапка merge request'а: заголовок, автор, ветки, описание.",
  usage: "mpu mr view [--mr REF] [--json]",
  help: `Печатает четыре строки — заголовок, автор, ветки, адрес — и
описание MR под ними.

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid. Без флага
project берётся из git remote origin текущего каталога, а iid — у
единственного открытого MR текущей ветки; ноль или несколько открытых
MR — отказ с перечнем.

--json печатает объект MR целиком: project, iid, title, state,
source_branch, target_branch, web_url, author_name, author_username,
description, diff_refs, project_id, sha, merge_commit_sha,
squash_commit_sha. diff_refs — три SHA диффа либо null.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — нераспознанный --mr; 1 — отказ GitLab, ненайденный
MR, неопределимая ветка.

Примеры: mpu mr view; mpu mr view --mr 'group/repo!456' --json`,
  policy: "ro",
  argsSchema,
  resultSchema,
  run: (args: ViewArgs, io: MrIo) => runView(args, io),
  render: (result: ViewResult, args: ViewArgs) => renderView(result, args.json),
});
