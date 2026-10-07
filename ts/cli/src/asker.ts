import type { AskKind } from "../../back/src/frames/mod.ts";
import type { TerminalIo } from "./terminal/mod.ts";

/**
 * Кто отвечает на кадр `ask` (`cli-client.md`, «Канал и токен»): человек
 * за терминалом или никто. Выбирается один раз при старте.
 */

/** Отвечающий на вопрос сервера. */
export interface Asker {
  /** Есть ли кого спросить — поле `human` первого кадра. */
  readonly present: boolean;
  /**
   * Ответ на вопрос; ответа не будет — пустая строка (для сервера
   * «нет»). Вид вопроса выбирает, как читать: видимо или без эха.
   *
   * @param signal вопрос решён в другом месте: чтение бросается
   */
  answer(question: string, kind: AskKind, signal: AbortSignal): Promise<string>;
}

/**
 * Чтение до ответа или до снятия вопроса. Начатое чтение терминала Deno
 * прервать не умеет: снятый вопрос его просто больше не ждёт, а терминал
 * закрывает вызывающий. Исход брошенного чтения — и строка, и отказ
 * закрытого файла — уже никому не нужен: ответ решён в другом месте.
 */
function unlessSettled(
  reading: Promise<string | undefined>,
  signal: AbortSignal,
): Promise<string | undefined> {
  const settled = Promise.withResolvers<undefined>();
  const stop = () => settled.resolve(undefined);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const read = reading.finally(() => signal.removeEventListener("abort", stop));
  read.catch(() => {
    // Отказ чтения, которого никто не ждёт (см. выше), — не сбой:
    // дождавшийся получит его сам из `Promise.race`.
  });
  return Promise.race([read, settled.promise]);
}

/**
 * Человек за управляющим терминалом: вопрос показывается там же, где
 * его увидит человек, ответ читается оттуда же (`cli-client.md`,
 * «Канал и токен»). Два вида чтения — две реализации, выбранные видом
 * вопроса, а не проверка «скрытый ли» на каждом чтении
 * (`platform/line-prompt.md`).
 *
 * @param open открыть управляющий терминал; его нет — ответа не будет
 */
export function humanAsker(open: () => Promise<TerminalIo | undefined>): Asker {
  return {
    present: true,
    answer: async (question, kind, signal) => {
      using terminal = await open();
      // Терминал исчез между стартом и вопросом: для сервера это
      // пустой ответ, то есть «нет».
      if (terminal === undefined) return "";
      await terminal.write(question);
      const reading: Readonly<
        Record<AskKind, () => Promise<string | undefined>>
      > = {
        line: () => terminal.readLine(),
        secret: () => terminal.readSecret(),
      };
      return (await unlessSettled(reading[kind](), signal)) ?? "";
    },
  };
}

/** Спросить некого: ответ «нет» сразу. */
export const NOBODY: Asker = {
  present: false,
  answer: () => Promise.resolve(""),
};
