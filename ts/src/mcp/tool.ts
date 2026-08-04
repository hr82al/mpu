/**
 * Тип тула и способ его исполнить — общее для обеих проекций. Отдельный
 * модуль, потому что проекции живут в разных местах: команда контракта
 * описывает себя кодом (`native_tool.ts`), команда маршрута `legacy` —
 * слепком дерева (`legacy_tools.ts`), и обе ссылаются на эти типы. Будь
 * они в модуле сборки профилей, получился бы цикл импортов.
 */

import type { CommandIo, Policy } from "../command/mod.ts";

/** Профиль сервера: путь `/ro` или `/rw`. */
export type Profile = "ro" | "rw";

/** JSON Schema как она уходит клиенту. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * Тул в ответе `tools/list`. Схема результата есть только у команд
 * маршрута `native`: у подпроцесса её нет и быть не может — он отдаёт
 * текст (`platform/mcp-server.md`, «Ответ legacy-тула»).
 */
export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: { readonly readOnlyHint: boolean };
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
}

/** Итог вызова тула: текст для агента и, у native, структурный результат. */
export interface ToolCallResult {
  /** Команда сообщила о неуспехе; для агента это доменная ошибка. */
  readonly isError: boolean;
  readonly text: string;
  /** Структурное содержимое; у маршрута `legacy` его нет. */
  readonly structured?: unknown;
}

/**
 * Тул и способ его исполнить. Ядро диспетчера не различает источники:
 * ему нужен вызов, а откуда взялись схема и описание — забота проекции.
 */
export interface ToolEntry {
  readonly tool: Tool;
  readonly policy: Policy;
  /** Путь команды: по нему тул восстанавливает имя в ошибках. */
  readonly path: readonly string[];
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
