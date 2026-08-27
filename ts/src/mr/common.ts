/**
 * Общее для всех подкоманд `mpu mr` (`mr-read.md`, `mr-write.md`):
 * доступ к GitLab, резолв `--mr` и перевод отказов атома в ошибки
 * команды.
 *
 * Копия на команду значила бы четырнадцать мест правки при изменении
 * текста подсказки или класса ошибки — а подсказка здесь несёт больше, чем
 * вежливость: по ней оператор понимает, чинить ли ему токен или форму
 * селектора.
 */

import { type CommandIo, DomainError, UsageError } from "../command/mod.ts";
import {
  DEFAULT_BASE_URL,
  DiscussionRefError,
  type GitlabAccess,
  GitlabError,
  type MrAddress,
  MrRefError,
  type ResolveContext,
  resolveMr,
  type RunGit,
} from "../gitlab/mod.ts";
import { spawnGit } from "../gitlab/git.ts";
import { envFilePath } from "../env/mod.ts";

/** Срез порта: env-файл (доступ) и каталог вызова (git-резолв). */
export type MrIo = Pick<CommandIo, "envFile" | "env" | "cwd">;

/** Подстановка для тестов: запуск git; сеть подменяется адресом стенда. */
export interface MrOptions {
  readonly runGit?: RunGit;
}

/**
 * Доступ к GitLab. Отсутствие `GLAB_TOKEN` — отказ env-слоя (exit 1 с
 * путём файла), а не ошибка ввода: команда набрана верно, не настроено
 * окружение (`platform/gitlab-api.md`, «Ошибки на уровне команды»).
 */
export function gitlabAccess(io: MrIo): GitlabAccess {
  const baseUrl = io.envFile.get("GITLAB_BASE_URL");
  return {
    baseUrl: baseUrl === undefined || baseUrl === ""
      ? DEFAULT_BASE_URL
      : baseUrl,
    token: io.envFile.require("GLAB_TOKEN"),
  };
}

/** Адрес MR по селектору; git запускается только при неполном селекторе. */
export async function mrAddress(
  io: MrIo,
  access: GitlabAccess,
  ref: string | undefined,
  options: MrOptions = {},
): Promise<MrAddress> {
  const context: ResolveContext = {
    access,
    cwd: io.cwd(),
    runGit: options.runGit ?? spawnGit,
  };
  try {
    return await resolveMr(context, ref);
  } catch (err) {
    throw asCommandError(io, err);
  }
}

/**
 * Отказ атома — ошибка команды. Разбор селектора разбирается до всякой
 * сети и потому остаётся ошибкой ввода (exit 2); всё, что случилось
 * после обращения наружу, — доменная ошибка (exit 1), включая «MR не
 * найден» и «дискуссия не найдена»: сущности нет на стороне GitLab, а
 * не в наборанной строке (`mr-read.md`, «Открытые вопросы»).
 */
export function asCommandError(io: MrIo, err: unknown): unknown {
  if (err instanceof MrRefError) {
    return err.input
      ? new UsageError(err.message, { cause: err })
      : new DomainError(err.message, { cause: err });
  }
  if (err instanceof DiscussionRefError) {
    return new DomainError(err.message, { cause: err });
  }
  if (err instanceof GitlabError) {
    return new DomainError(`gitlab error: ${err.message}${hintFor(io, err)}`, {
      cause: err,
    });
  }
  return err;
}

/** Подсказка по коду ответа: чинить токен либо форму селектора. */
function hintFor(io: MrIo, err: GitlabError): string {
  if (err.status === 401) {
    // Называется ключ и путь файла, но не значение: токен не попадает
    // ни в один текст (инвариант спеки).
    return `; проверь GLAB_TOKEN в ${envFilePathOf(io)}`;
  }
  if (err.status === 404) {
    return "; проверь --mr (URL | 'group/repo!iid' | iid)";
  }
  return "";
}

/**
 * Путь env-файла для подсказки — из того же правила, что у самого
 * env-слоя: своя копия расходилась бы с ним при заданном
 * `XDG_CONFIG_HOME` и называла бы файл, которого нет.
 */
function envFilePathOf(io: MrIo): string {
  return envFilePath(io.env) ?? "~/.config/mpu/.env";
}
