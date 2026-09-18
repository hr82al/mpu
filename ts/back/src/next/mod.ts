/**
 * Точка входа `mpu-next` (`platform/registry-objects.md`): строка вызова
 * исполняется цепочкой сообщений по дереву реестра, а команду исполняет
 * нынешняя диспетчеризация, получая исходную строку целиком, — если
 * позволяют правила подтверждения (`platform/policy.md`).
 */

import type { CommandIo } from "../command/mod.ts";
import { JSON_FLAG, type Output, runLine } from "../entrypoint/mod.ts";
import { ESCAPE_WORD } from "../messages/mod.ts";
import { type Outcome, runChain } from "../objects/mod.ts";
import {
  type Channel,
  Human,
  NOBODY,
  PolicyError,
  RuleBook,
} from "../policy/mod.ts";
import type { CliEntry } from "../process/mod.ts";
import { registrySeeds } from "./seeds.ts";
import { Session } from "./session.ts";
import { registryRoot } from "./tree.ts";

/**
 * Слова для обхода цепочки: без `--json` до первого `--` — иначе корень
 * получил бы непонятое сообщение. Исполнение получает исходный argv.
 */
function walkedWords(argv: readonly string[]): string[] {
  const cut = argv.indexOf(ESCAPE_WORD);
  const end = cut < 0 ? argv.length : cut;
  return [
    ...argv.slice(0, end).filter((word) => word !== JSON_FLAG),
    ...argv.slice(end),
  ];
}

/** Итог цепочки в поток и код (данные границы). */
function printed(outcome: Outcome, output: Output): number {
  if ("error" in outcome) {
    output.stderr(`${outcome.error}\n`);
    return 2;
  }
  if ("exit" in outcome) return outcome.exit;
  if ("object" in outcome) {
    output.stdout(outcome.object);
    return 2;
  }
  output.stdout(textOf(outcome.value));
  return 0;
}

/**
 * Данные итога текстом: справка — строка как есть; ответы `selectors` и
 * `respondsTo:` — JSON (формы их печати спека не задаёт).
 */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  return `${JSON.stringify(value)}\n`;
}

/** Окружение правил подтверждения у точки входа. */
export interface Consent {
  /** Файл правил; каталога состояния нет — `undefined`. */
  readonly file: string | undefined;
  /** Одна строка ответа человека из stdin; конец ввода — `undefined`. */
  readonly readLine: () => Promise<string | undefined>;
}

/**
 * Файл правил в каталоге состояния (`platform/policy.md`, «Хранение»).
 *
 * @param stateDir каталог состояния; `undefined` — нет HOME
 */
export function policyFile(stateDir: string | undefined): string | undefined {
  return stateDir === undefined ? undefined : `${stateDir}/policy.db`;
}

/**
 * Канал вызова: человек — только когда и stdin, и stderr терминалы;
 * вопрос — в stderr, ответ — строка stdin.
 */
function channelOf(io: CommandIo, output: Output, consent: Consent): Channel {
  if (!io.stdinIsTerminal() || !io.stderrIsTerminal()) return NOBODY;
  return new Human(output.stderr, consent.readLine);
}

/**
 * Точка входа `mpu-next`: исполняет строку вызова и возвращает код
 * завершения. Файл правил открывается до разбора строки — нечитаемый
 * файл отказывает любой строке, включая справку.
 *
 * @param consent файл правил и чтение ответа человека
 */
export function nextEntry(consent: Consent): CliEntry {
  return async (argv, io, output, journal) => {
    let book: RuleBook;
    try {
      book = RuleBook.open(consent.file, registrySeeds());
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      output.stderr(`${err.message}\n`);
      return 1;
    }
    using _book = book;
    const line = new Session({
      book,
      channel: channelOf(io, output, consent),
      output,
      dispatch: () => runLine(argv, io, output, journal),
    });
    const outcome = await runChain(walkedWords(argv), registryRoot(line));
    return printed(outcome, output);
  };
}
