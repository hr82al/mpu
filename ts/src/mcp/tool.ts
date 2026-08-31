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
 * Имя тула из пути команды: сегменты соединяются `_`, дефисы внутри
 * сегмента тоже становятся `_`.
 */
export function toolName(path: readonly string[]): string {
  return path.join("_").replaceAll("-", "_");
}
