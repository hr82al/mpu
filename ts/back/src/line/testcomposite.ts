/**
 * Случаи `ask` в составной строке для голденов
 * `testdata/ask-door/composite-*.json` (`platform/ask-composite.md`,
 * «Golden-примеры»): строка на стенде программы с правилами таблицы спеки —
 * `kiten ls` allow, `kiten comment` ask, `sql` deny.
 */

import type { RefusalData } from "../frames/mod.ts";
import { ASK, DENY, RuleBook, RulePath } from "../policy/mod.ts";
import { allowEverything, withPolicyFile } from "./testconsent.ts";
import {
  type Frame,
  KAITEN_MARK,
  runOnStand,
  unmarked,
  withStand,
} from "./testprogram.ts";

/** Что задаёт случай: строка с метками и обстоятельства. */
export interface CompositeInput {
  readonly описание: string;
  readonly строка: string;
  readonly ответы: readonly string[];
  /** Человека нет (канал агента): stdin не терминал. */
  readonly "без человека": boolean;
  /** Правило `kiten comment` → ask ставит другой процесс посреди строки. */
  readonly "правило посреди строки": boolean;
}

/** Случай целиком: вход и снятый прогоном итог. */
export interface CompositeCase extends CompositeInput {
  readonly кадры: readonly Frame[];
  /** Созданные комментарии: `карточка текст`. */
  readonly созданные: readonly string[];
  readonly отказ: RefusalData | null;
  readonly код: number;
}

/** Правила таблицы спеки; посреди строки — только чтение до смены. */
function rules(file: string, midway: boolean) {
  allowEverything(file);
  using book = RuleBook.open(file, []);
  if (!midway) book.set(RulePath.parse("kiten comment"), ASK);
  book.set(RulePath.parse("sql"), DENY);
}

/** Прогон случая на стенде. */
export async function runComposite(
  input: CompositeInput,
): Promise<CompositeCase> {
  let taken: CompositeCase | undefined;
  const midway = input["правило посреди строки"];
  await withPolicyFile((file) =>
    withStand(
      async (stand) => {
        rules(file, midway);
        const ran = await runOnStand(
          file,
          unmarked(input.строка).split(" "),
          stand,
          {
            answers: input.ответы,
            io: input["без человека"] ? { stdinIsTerminal: () => false } : {},
          },
        );
        const marked = (text: string) =>
          text.replaceAll(stand.baseUrl, KAITEN_MARK);
        taken = {
          ...input,
          кадры: ran.frames.map((frame) =>
            "out" in frame
              ? { out: marked(frame.out) }
              : { err: marked(frame.err) }
          ),
          созданные: stand.posted(),
          отказ: ran.refusals[0] ?? null,
          код: ran.exit,
        };
      },
      () => {
        if (!midway) return;
        using book = RuleBook.open(file, []);
        book.set(RulePath.parse("kiten comment"), ASK);
      },
    )
  );
  if (taken === undefined) throw new Error("стенд не прогнал случай");
  return taken;
}

/** Каталог голденов случаев. */
export const COMPOSITE_DIR = new URL("testdata/ask-door/", import.meta.url);

/** Имена файлов случаев по алфавиту. */
export async function compositeFiles(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(COMPOSITE_DIR)) {
    if (entry.name.startsWith("composite-")) names.push(entry.name);
  }
  return names.sort();
}
