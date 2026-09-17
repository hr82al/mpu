/**
 * Команды `mpu mr resolve` и `mpu mr unresolve`
 * (`docs/specs/mr-write.md`): закрыть и открыть тред ревью.
 *
 * Обе — одна и та же операция с разным признаком, поэтому объявлены
 * рядом: разойдясь по файлам, они разошлись бы и по текстам.
 *
 * Нерезолвабельный тред отбивается ДО запроса: GitLab на него ответил
 * бы невнятно, а признак у нас уже есть — он сведён атомом по нотам.
 */

import { z } from "@zod/zod";
import { type Command, defineCommand, DomainError } from "../command/mod.ts";
import {
  discussions,
  matchDiscussion,
  setDiscussionResolved,
} from "../gitlab/mod.ts";
import {
  asCommandError,
  gitlabAccess,
  mrAddress,
  type MrIo,
  type MrOptions,
} from "./common.ts";

const argsSchema = z.object({
  discussion: z.string({
    error: "нужен DISCUSSION: полный id треда или префикс от 6 символов",
  }).describe("id треда или его префикс (≥6 символов)"),
  mr: z.string().optional().describe(
    "MR: URL | 'group/repo!iid' | iid; без флага — открытый MR ветки",
  ),
});

const resultSchema = z.object({
  discussion: z.string().describe("id треда"),
  resolved: z.boolean().describe("новое состояние треда"),
});

type ResolveArgs = z.infer<typeof argsSchema>;
type ResolveResult = z.infer<typeof resultSchema>;

/** Ход вызова: тред по селектору, проверка резолвабельности, PUT. */
export async function runResolve(
  args: ResolveArgs,
  io: MrIo,
  resolved: boolean,
  options: MrOptions = {},
): Promise<ResolveResult> {
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  try {
    const thread = matchDiscussion(
      await discussions(access, address),
      args.discussion,
    );
    if (!thread.resolvable) {
      // Запрос не отправляется вовсе: резолвить нечего, и отказ должен
      // называть причину, а не пересказывать ответ GitLab.
      throw new DomainError(
        `тред ${thread.id.slice(0, 8)} нерезолвабельный (general note)`,
      );
    }
    await setDiscussionResolved(access, address, thread.id, resolved);
    return { discussion: thread.id, resolved };
  } catch (err) {
    throw asCommandError(io, err);
  }
}

export function renderResolve(result: ResolveResult): string {
  const state = result.resolved ? "resolved" : "unresolved";
  return `discussion ${result.discussion.slice(0, 8)}: ${state}\n`;
}

/** Общая часть объявления: различаются только имя, текст и признак. */
function resolveCommand(resolved: boolean): Command {
  const name = resolved ? "resolve" : "unresolve";
  const action = resolved ? "Закрыть" : "Переоткрыть";
  return defineCommand({
    path: ["mr", name],
    errorName: `mr ${name}`,
    summary: `${action} тред ревью merge request'а.`,
    usage: `mpu mr ${name} DISCUSSION [--mr REF]`,
    help: `${action} тред ревью.

DISCUSSION — полный id треда либо его префикс от 6 символов; восемь
символов из mpu mr comments годятся. Префикс, подошедший нескольким
тредам, — отказ с перечнем.

Общий тред без резолвабельных заметок закрыть нельзя: команда
отказывается до запроса и говорит об этом прямо. Повторный ${name}
уже ${resolved ? "закрытого" : "открытого"} треда запрос выполняет:
состояние заранее не проверяется.

Системные треды GitLab (смена описания, отметки о резолве) списком не
показываются, и по их идентификатору команда отвечает «дискуссия не
найдена в этом MR».

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid; без флага —
открытый MR текущей ветки.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — DISCUSSION не передан, нераспознанный --mr; 1 —
отказ GitLab, ненайденный или неоднозначный тред, нерезолвабельный тред.

Примеры: mpu mr ${name} 953d395b; mpu mr ${name} 953d395b --mr 456`,
    policy: "rw",
    argsSchema,
    forms: { discussion: { positional: "one" } },
    resultSchema,
    run: (args: ResolveArgs, io: MrIo) => runResolve(args, io, resolved),
    render: (result: ResolveResult) => renderResolve(result),
  });
}

export const mrResolveCommand = resolveCommand(true);
export const mrUnresolveCommand = resolveCommand(false);
