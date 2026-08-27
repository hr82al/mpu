/**
 * Команда `mpu mr describe` (`docs/specs/mr-write.md`): замена
 * описания MR целиком.
 *
 * Целиком — не оговорка: PUT кладёт новое описание вместо прежнего, и
 * дописать к нему нельзя. Отсюда `-F` как основная форма: описание
 * обычно готовится в файле, а не набирается одной строкой.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { updateDescription } from "../gitlab/mod.ts";
import { type BodyIo, commentBody } from "./body.ts";
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
  message: z.string().optional().describe("новое описание"),
  "body-file": z.string().optional().describe(
    "файл с описанием; '-' — весь stdin, только в CLI",
  ),
});

const resultSchema = z.object({
  project: z.string(),
  iid: z.number(),
  url: z.string().describe("web_url MR из ответа GitLab"),
});

type DescribeArgs = z.infer<typeof argsSchema>;
type DescribeResult = z.infer<typeof resultSchema>;

/** Ход вызова: тело до сети, затем PUT описания. */
export async function runDescribe(
  args: DescribeArgs,
  io: MrIo & BodyIo,
  options: MrOptions = {},
): Promise<DescribeResult> {
  const description = await commentBody(args, io);
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  try {
    // Ответ PUT — сам MR, поэтому отдельного GET ради ссылки нет.
    const mr = await updateDescription(access, address, description);
    return {
      project: address.project,
      iid: address.iid,
      url: mr.web_url,
    };
  } catch (err) {
    throw asCommandError(io, err);
  }
}

export function renderDescribe(result: DescribeResult): string {
  return `описание MR ${result.project}!${result.iid} обновлено\n` +
    `${result.url}\n`;
}

export const mrDescribeCommand = defineCommand({
  path: ["mr", "describe"],
  errorName: "mr describe",
  summary: "Заменить описание merge request'а целиком.",
  usage: "mpu mr describe [--mr REF] (-m TEXT | -F PATH)",
  help: `Заменяет описание MR целиком: новый текст встаёт вместо
прежнего, дописать к нему нельзя.

Текст — ровно один из -m/--message TEXT и -F/--body-file PATH; '-'
вместо пути означает весь stdin и работает только в CLI. Тело уходит
дословно, поэтому markdown, ссылки и переводы строк сохраняются.

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid; без флага —
открытый MR текущей ветки.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — сочетание флагов тела, пустое тело,
нераспознанный --mr; 1 — отказ GitLab, ненайденный MR.

Примеры: mpu mr describe -F описание.md;
mpu mr describe --mr 456 -m 'Правит загрузчик WB.'`,
  policy: "rw",
  argsSchema,
  forms: { message: { short: "m" }, "body-file": { short: "F" } },
  resultSchema,
  run: (args: DescribeArgs, io: MrIo & BodyIo) => runDescribe(args, io),
  render: (result: DescribeResult) => renderDescribe(result),
});
