/**
 * Команда `mpu mr comments` (`docs/specs/mr-read.md`): треды ревью MR в
 * трёх формах.
 *
 * Самая частая подкоманда семейства: ею читают, что ревьюер попросил
 * поправить. Отсюда `--md` — форму, которую можно целиком отдать
 * агенту или вставить в задачу, — и фильтры, которые складываются.
 */

import { z } from "@zod/zod";
import { defineCommand, UsageError } from "../command/mod.ts";
import { discussions, mergeRequest } from "../gitlab/mod.ts";
import {
  asCommandError,
  gitlabAccess,
  mrAddress,
  type MrIo,
  type MrOptions,
} from "./common.ts";
import { mrHeadline } from "./cmd_view.ts";
import {
  filterDiscussions,
  renderThreadsMarkdown,
  renderThreadTable,
  type Thread,
  threadOf,
  threadSchema,
} from "./threads.ts";

const argsSchema = z.object({
  mr: z.string().optional().describe(
    "MR: URL | 'group/repo!iid' | iid; без флага — открытый MR ветки",
  ),
  unresolved: z.boolean().default(false).describe(
    "только незакрытые треды (resolvable и не resolved)",
  ),
  file: z.string().optional().describe("подстрока пути позиции треда"),
  author: z.string().optional().describe(
    "подстрока автора первой ноты, без учёта регистра",
  ),
  json: z.boolean().default(false).describe("массив тредов JSON"),
  md: z.boolean().default(false).describe("markdown: тред за тредом"),
});

const resultSchema = z.object({
  headline: z.string().describe("строка заголовка MR над таблицей"),
  threads: z.array(threadSchema).describe("треды после фильтров"),
});

type CommentsArgs = z.infer<typeof argsSchema>;
type CommentsResult = z.infer<typeof resultSchema>;

/** Ход вызова: шапка MR ради заголовка и треды одним списком. */
export async function runComments(
  args: CommentsArgs,
  io: MrIo,
  options: MrOptions = {},
): Promise<CommentsResult> {
  // Конфликт форматов отбивается до сети: два взаимоисключающих флага —
  // ошибка ввода, а не повод молча выбрать один (отклонение fix спеки).
  if (args.json && args.md) {
    throw new UsageError("only one of --json / --md can be set");
  }
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  try {
    const mr = await mergeRequest(access, address);
    const threads = filterDiscussions(await discussions(access, address), {
      unresolved: args.unresolved,
      file: args.file,
      author: args.author,
    });
    return { headline: mrHeadline(mr), threads: threads.map(threadOf) };
  } catch (err) {
    throw asCommandError(io, err);
  }
}

/** Три формы вывода одних и тех же тредов. */
export function renderComments(
  result: CommentsResult,
  args: Pick<CommentsArgs, "json" | "md">,
): string {
  const threads: readonly Thread[] = result.threads;
  if (args.json) return `${JSON.stringify(threads, null, 2)}\n`;
  if (args.md) return renderThreadsMarkdown(result.headline, threads);
  return renderThreadTable(result.headline, threads);
}

export const mrCommentsCommand = defineCommand({
  path: ["mr", "comments"],
  errorName: "mr comments",
  summary: "Треды ревью merge request'а: таблица, JSON или markdown.",
  usage:
    "mpu mr comments [--mr REF] [--unresolved] [--file S] [--author S] [--json|--md]",
  help: `Печатает треды ревью MR таблицей: первые 8 символов id, признак
резолва (✓ закрыт, · открыт, пусто — общий тред), позиция в диффе,
автор первой ноты, число нот и начало первой ноты. Последняя строка —
сколько всего тредов и сколько из них открыто.

Системные записи GitLab («изменил заголовок», «назначил ревьюера») не
показываются ни в одной форме.

Фильтры складываются:
--unresolved — только незакрытые треды;
--file SUBSTR — только треды, чья позиция указывает на файл с такой
подстрокой в пути; тред без позиции при этом фильтре отпадает;
--author SUBSTR — подстрока в имени или username автора первой ноты,
без учёта регистра.

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid; без флага —
открытый MR текущей ветки.

--json печатает массив тредов {id, resolvable, resolved, location,
notes}; --md печатает markdown с телами нот целиком. Вместе они не
задаются: это ошибка ввода.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех, в том числе когда после фильтров не осталось тредов;
2 — нераспознанный --mr, --json вместе с --md; 1 — отказ GitLab,
ненайденный MR.

Примеры: mpu mr comments --unresolved; mpu mr comments --mr 456 --md`,
  policy: "ro",
  argsSchema,
  resultSchema,
  run: (args: CommentsArgs, io: MrIo) => runComments(args, io),
  render: (result: CommentsResult, args: CommentsArgs) =>
    renderComments(result, args),
});
