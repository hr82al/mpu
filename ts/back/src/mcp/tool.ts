/**
 * Тип тула и способ его исполнить. Отдельный модуль, а не часть сборки
 * профилей: иначе проекция (`native_tool.ts`) и сборка (`tools.ts`)
 * ссылались бы друг на друга, и получился бы цикл импортов.
 *
 * Проекция теперь одна: маршрут `legacy`, описывавший тул слепком
 * дерева, снят целиком (порция 97). Вместе с ним ушли поля «а у того
 * маршрута этого нет» — схема результата, структурное содержимое и
 * пометка журналу перестали быть необязательными.
 */

import type { CommandIo, Policy } from "../command/mod.ts";
import type { OutputPolicy } from "../invokelog/mod.ts";

/** Профиль сервера: путь `/ro` или `/rw`. */
export type Profile = "ro" | "rw";

/** JSON Schema как она уходит клиенту. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Тул в ответе `tools/list`. */
export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  /**
   * Служебные поля протокола. Здесь живёт требование подтверждения на
   * каждый вызов: аннотация описывает свойство тула, а включает
   * подтверждение именно это поле (`platform/mcp-server.md`).
   */
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** Аннотации тула: что клиент знает о нём до вызова. */
interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  /**
   * Эффект необратим вне этой машины. Выставляется только тулам из
   * секции `destructive` закрытого списка: по описанию команды признак
   * не выводится — `logs` и `sql` для кода выглядят одинаково.
   */
  readonly destructiveHint?: true;
}

/** Ключ требования подтверждения на каждый вызов. */
export const REQUIRES_INTERACTION = "anthropic/requiresUserInteraction";

/**
 * Помечает тул как необратимый: аннотацией — для любого клиента, полем
 * `_meta` — потому что подтверждение включает именно оно. Непомеченный
 * тул возвращается как есть: лишние ключи в ответе — тоже расхождение.
 */
export function asDestructive(tool: Tool): Tool {
  return {
    ...tool,
    annotations: { ...tool.annotations, destructiveHint: true },
    _meta: { [REQUIRES_INTERACTION]: true },
  };
}

/**
 * Итог вызова тула: текст для агента и структурный результат. Признака
 * «неуспех» здесь нет: команда контракта сообщает о нём исключением
 * (`DomainError`), а ненулевого кода подпроцесса больше не бывает.
 */
export interface ToolCallResult {
  readonly text: string;
  readonly structured: unknown;
}

/**
 * Тул и способ его исполнить. Ядро диспетчера не различает источники:
 * ему нужен вызов, а откуда взялись схема и описание — забота проекции.
 */
export interface ToolEntry {
  readonly tool: Tool;
  readonly policy: Policy;
  /** Путь команды: по нему тул восстанавливает своё имя. */
  readonly path: readonly string[];
  /** Имя команды в префиксе её ошибок (`Command.errorName`). */
  readonly errorName: string;
  /** Пометка журнала вызовов (`platform/invoke-log.md`). */
  readonly journal: OutputPolicy;
  readonly invoke: (
    args: unknown,
    io: CommandIo,
  ) => Promise<ToolCallResult>;
}

/**
 * Предел описания у клиента: длиннее он режет сам и молча
 * (`platform/mcp-server.md`, «Объём»). Поэтому режем мы — и называем это.
 */
export const DESCRIPTION_LIMIT = 2048;

const utf8 = new TextEncoder();

/**
 * Описание в пределах, которые держит клиент. Не влезающее усекается по
 * границе СТРОКИ и называет себя усечённым: молчаливая обрезка на
 * стороне клиента недопустима — агент не отличил бы её от конца текста
 * и решил бы, что прочитал справку целиком.
 *
 * Маркер говорит и чем это чинится: полный текст у команды есть всегда,
 * и взять его — одна строка в терминале.
 *
 * Что именно уцелеет, решает порядок изложения справки, а не эта
 * функция: повод звать и контракт аргументов ставятся в начале, примеры
 * и коды выхода — в конце, и жертвуются первыми
 * (`platform/mcp-server.md`, «Объём»). Требование к справке, не
 * утверждение о ней: справка, написанная иначе, потеряет нужное.
 *
 * @param description описание целиком
 * @param path путь команды для строки «полностью — …»
 */
export function fitDescription(
  description: string,
  path: readonly string[],
): string {
  const whole = utf8.encode(description).length;
  if (whole <= DESCRIPTION_LIMIT) return description;
  const lines = description.split("\n");
  for (let kept = lines.length - 1; kept > 0; kept--) {
    const head = lines.slice(0, kept).join("\n");
    const cut = withMarker(head, description, path);
    if (cut === undefined) continue;
    // Граница строки — минимум, которого требует спека; берётся
    // ближайшая граница АБЗАЦА, если она влезает. Обрыв посреди абзаца
    // читается как законченная мысль: перечень кодов выхода, оборванный
    // на втором из трёх, выглядит перечнем из двух.
    const blank = head.lastIndexOf("\n\n");
    const whole2 = blank > 0
      ? withMarker(head.slice(0, blank), description, path)
      : undefined;
    return whole2 ?? cut;
  }
  // Ни одной строки не уцелело: остаётся сказать хотя бы, что текст
  // отброшен целиком и где он лежит.
  return marker(whole, path);
}

/**
 * Уцелевшее плюс маркер, если это укладывается в предел; иначе
 * `undefined`. Отброшено — ровно то, что не уехало: разделитель между
 * уцелевшим и маркером в выводе остался и отброшенным не является.
 */
function withMarker(
  head: string,
  description: string,
  path: readonly string[],
): string | undefined {
  const dropped = utf8.encode(description.slice(head.length + 1)).length;
  const text = `${head}\n${marker(dropped, path)}`;
  return utf8.encode(text).length <= DESCRIPTION_LIMIT ? text : undefined;
}

function marker(dropped: number, path: readonly string[]): string {
  return `[справка усечена: отброшено ${dropped} байт; ` +
    `полностью — \`mpu ${path.join(" ")} --help\`]`;
}

/**
 * Имя тула из пути команды: сегменты соединяются `_`, дефисы внутри
 * сегмента тоже становятся `_`.
 */
export function toolName(path: readonly string[]): string {
  return path.join("_").replaceAll("-", "_");
}
