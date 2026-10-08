/**
 * Проба хука `PreToolUse` глазами ядра (`claude-hook-pre-tool-use.md`,
 * «Как находится решение»): та же проверка прежних форм и тот же
 * маршрут, та же цепочка, на месте сессии — проба.
 */

import type { HookReply } from "@mpu/cmd-claudehook";
import type { ImageMethod } from "@mpu/cmd-image";
import { runChain } from "@mpu/language/objects";
import type { RuleBook } from "@mpu/command/policy";
import { entryOf } from "./view.ts";
import {
  type Consulting,
  type OwnerHooks,
  probedReply,
  standingMethods,
} from "./hook.ts";
import { formerOf } from "./former.ts";
import { routeOf } from "./route.ts";
import type { RootMethod } from "./rules.ts";
import type { Targets } from "./keyed.ts";
import { registryRoot } from "./tree.ts";
import { strippedOf, walkedWords } from "./walked.ts";

/** Что пробе нужно от строки ядра. */
export interface ConsultingParts {
  /** Правила строки — у пробы те же. */
  readonly book: RuleBook;
  /** Методы образа. */
  readonly methods: readonly ImageMethod[];
  /** Методы корня двери: в пробе у них те же имя и справка. */
  readonly rootMethods: readonly RootMethod[];
  /** Значения ключа `target:`. */
  readonly targets: Targets;
  /** stdin строки — порт строки хука в маршруте. */
  readonly readStdin: () => Promise<Uint8Array>;
  /** Вопросы владельцу строк-хуков — порт их строк в маршруте. */
  readonly owner: OwnerHooks;
}

/** Ответ хука по прежним формам, маршруту и цепочке строки ядра. */
export class LineConsulting implements Consulting {
  readonly #parts: ConsultingParts;

  constructor(parts: ConsultingParts) {
    this.#parts = parts;
  }

  reply(words: readonly string[]): Promise<HookReply> {
    const { readStdin, owner } = this.#parts;
    const walked = walkedWords(words);
    const door = entryOf(walked).words.length;
    const hook = { readStdin, consulting: this, owner };
    return formerOf(words, walked.slice(door)).consult(() =>
      routeOf(walked.slice(door), hook).consult(() =>
        this.#probed(words, walked),
      ),
    );
  }

  /** Обычная цепочка: обход слов с пробой на месте сессии. */
  #probed(
    words: readonly string[],
    walked: readonly string[],
  ): Promise<HookReply> {
    const { book, methods, rootMethods, targets } = this.#parts;
    return probedReply(book, words, (probe, values) =>
      runChain(
        walked,
        registryRoot(probe, book, {
          own: standingMethods(rootMethods),
          targets,
          image: methods,
          stripped: strippedOf(words),
        }),
        values,
      ),
    );
  }
}
