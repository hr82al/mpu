/**
 * Откуда тела запроса `mpu code twins` (`specs/code-twins.md`): адрес —
 * одно тело, дифф — тела, тронутые изменением против базы. Режим по
 * диффу — второй источник тел запроса, а не вторая команда: тело и его
 * близнецы считает один `Twins`.
 */

import { type CommandIo, UsageError } from "@mpu/command";
import { parseAddress } from "./address.ts";
import type { Analyzer } from "./analyzer.ts";
import type { FoundBodies } from "./body.ts";
import { type MergeBase, mergeBase } from "./changed_lines.ts";
import { spawnGit } from "./git.ts";
import type { TreeMark } from "./mark.ts";
import { openAnalyzer, openRepoAnalyzer } from "./open.ts";
import { diffRepo, resolveRepo } from "./sweep.ts";
import {
  type AnswerPart,
  type Asking,
  addressPart,
  checkFile,
  diffPart,
} from "./twins.ts";
import type { Repo } from "./workspace.ts";

/** Отказ без адреса и без базы: вопроса нет. */
export const NO_QUESTION =
  "адрес обязателен: [РЕПОЗИТОРИЙ:]ПУТЬ:СТРОКА либо --base REF";

/** Разобранные ключи команды. */
export interface TwinsArgs {
  readonly address?: string;
  readonly base?: string;
  readonly in?: string;
  readonly limit: number;
}

/** Источник тел запроса: окно разбора и своя часть ответа. */
export interface Queries extends Asking {
  /** Репозиторий ответа: его отметку несёт и отказ построения. */
  readonly repo: Repo;
  /** Анализатор окна вопроса. */
  open(): Promise<Analyzer>;
}

/** Одно тело — у объявления-функции, охватывающего строку адреса. */
class AddressQueries implements Queries {
  constructor(
    private readonly path: string,
    private readonly line: number,
    readonly repo: Repo,
  ) {}

  open(): Promise<Analyzer> {
    return openAnalyzer(this.repo, this.path);
  }

  check(analyzer: Analyzer, mark: TreeMark): void {
    checkFile(this.path, this.repo, analyzer, mark);
  }

  part(
    found: FoundBodies,
    analyzer: Analyzer,
    limit: number,
  ): Promise<AnswerPart> {
    return Promise.resolve(
      addressPart(this.path, this.line, found, analyzer, limit),
    );
  }
}

/** Тела, тронутые диффом против базы; окно — репозиторий целиком. */
class DiffQueries implements Queries {
  constructor(
    readonly repo: Repo,
    private readonly base: MergeBase,
  ) {}

  open(): Promise<Analyzer> {
    return openRepoAnalyzer(this.repo);
  }

  /** Файла у вопроса нет — проверять до разбора нечего. */
  check(): void {}

  async part(
    found: FoundBodies,
    analyzer: Analyzer,
    limit: number,
  ): Promise<AnswerPart> {
    return diffPart(await this.base.changes(), found, analyzer, limit);
  }
}

/**
 * Источник тел запроса по ключам — граница разбора входа. База
 * разрешается здесь, до открытия анализатора: опечатка в ветке —
 * ошибка ввода, а не отказ раздела после построения программы. Строка
 * адреса — тоже: без неё тело не выбрать, и строить программу незачем.
 */
export async function queriesOf(
  args: TwinsArgs,
  io: Pick<CommandIo, "cwd">,
  repos?: readonly Repo[],
): Promise<Queries> {
  if (args.address !== undefined && args.base !== undefined) {
    throw new UsageError(
      "адрес и --base — разные вопросы: либо одно тело по адресу, либо тела, тронутые диффом",
    );
  }
  if (args.base !== undefined) {
    const repo = diffRepo(io.cwd(), args.in, repos);
    return new DiffQueries(
      repo,
      await mergeBase(spawnGit, repo.root, args.base),
    );
  }
  if (args.in !== undefined) {
    throw new UsageError("--in — репозиторий диффа: только вместе с --base");
  }
  if (args.address === undefined) throw new UsageError(NO_QUESTION);
  const address = parseAddress(args.address);
  const repo = resolveRepo(address, io.cwd(), repos);
  if (address.line === undefined) {
    throw new UsageError(
      "нужна строка: тело берётся у объявления, охватывающего её",
    );
  }
  return new AddressQueries(address.path, address.line, repo);
}
