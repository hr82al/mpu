/**
 * Подсказки правила из `permission_suggestions`
 * (`claude-hook-permission-request.md`, «Payload → форма вопроса»;
 * подписи — `telegram-relay-statement.md` §4): каждая подписывает себя
 * сама, а в решение уходит такой, какой пришла.
 */

import { type Fields, isFields } from "./fields.ts";

/** Подсказка правила. */
export interface Suggestion {
  /** Подпись после `Yes, always: `. */
  label(): string;
  /** Подсказка как пришла — в `updatedPermissions`. */
  raw(): Fields;
}

/** `addRules`: правило `<tool>(<content>)`, без содержания — `<tool>`. */
class RulesSuggestion implements Suggestion {
  readonly #raw: Fields;
  readonly #rules: readonly string[];

  constructor(raw: Fields, rules: readonly string[]) {
    this.#raw = raw;
    this.#rules = rules;
  }

  label(): string {
    return this.#rules.join(", ");
  }

  raw(): Fields {
    return this.#raw;
  }
}

/** Подсказка, подписанная готовым текстом: каталог или неизвестный вид. */
class SignedSuggestion implements Suggestion {
  readonly #raw: Fields;
  readonly #label: string;

  constructor(raw: Fields, label: string) {
    this.#raw = raw;
    this.#label = label;
  }

  label(): string {
    return this.#label;
  }

  raw(): Fields {
    return this.#raw;
  }
}

function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function ruleOf(rule: unknown): readonly string[] {
  if (!isFields(rule) || typeof rule.toolName !== "string") return [];
  const content = rule.ruleContent;
  return [
    typeof content === "string"
      ? `${rule.toolName}(${content})`
      : rule.toolName,
  ];
}

/**
 * Подсказка из элемента `permission_suggestions`; без строкового `type` —
 * незнакомое, и разбор терпимый: её нет.
 */
function suggestionOf(raw: unknown): readonly Suggestion[] {
  if (!isFields(raw) || typeof raw.type !== "string") return [];
  const type = raw.type;
  switch (type) {
    case "addRules": {
      const rules = Array.isArray(raw.rules) ? raw.rules.flatMap(ruleOf) : [];
      // Правил не разобрать — подпись видом, как у незнакомой.
      if (rules.length === 0) return [new SignedSuggestion(raw, type)];
      return [new RulesSuggestion(raw, rules)];
    }
    case "addDirectories": {
      const dirs = stringsOf(raw.directories).map((dir) => `dir ${dir}`);
      return [
        new SignedSuggestion(raw, dirs.length === 0 ? type : dirs.join(", ")),
      ];
    }
    default:
      return [new SignedSuggestion(raw, type)];
  }
}

/**
 * Подсказки payload'а по порядку; не список — как отсутствие.
 *
 * @param value поле `permission_suggestions`
 */
export function suggestionsOf(value: unknown): readonly Suggestion[] {
  return Array.isArray(value) ? value.flatMap(suggestionOf) : [];
}
