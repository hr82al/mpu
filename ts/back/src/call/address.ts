/**
 * Ключ адреса получателя (`docs/specs/call.md`, «Ключи»): у Ozon — `path:`
 * при хосте, заданном получателем; у WB — `url:`, хост из таблицы. Адрес
 * разбирает ввод в цель запроса и отказывает до чтения ключа.
 */

import type { z } from "zod";
import { UsageError } from "../command/mod.ts";
import { type CallArgs, pathArgs } from "./args.ts";

/** Куда уходит запрос. */
export interface Aim {
  readonly host: string;
  /** Путь без запроса — по нему сверяется реестр чтения. */
  readonly path: string;
  /** Адрес запроса целиком: `https://<хост><путь>[?запрос]`. */
  readonly url: string;
  /** Как ручка называется в отказе реестра чтения. */
  readonly named: string;
}

/** Ключ адреса получателя. */
export interface Address {
  /** Имя ключа в строке и в схеме аргументов. */
  readonly key: "path" | "url";
  readonly argsSchema: z.ZodType<CallArgs>;
  /** Ключ в строке использования: `path: ПУТЬ`. */
  readonly usage: string;
  /** Строка справки о ключе. */
  readonly help: string;
  /** Цель запроса; адрес не той формы — отказ ввода. */
  aim(args: CallArgs): Aim;
}

/** `path:` при хосте, заданном получателем. */
export class FixedHost implements Address {
  readonly key = "path";
  readonly argsSchema: z.ZodType<CallArgs> = pathArgs;
  readonly usage = "path: ПУТЬ";
  readonly host: string;

  constructor(host: string) {
    this.host = host;
  }

  get help(): string {
    return `path: — путь ручки с /; хост — ${this.host}.`;
  }

  aim(args: CallArgs): Aim {
    // Схема `pathArgs` требует `path:`; тип общий для обоих адресов.
    const path = args.path ?? "";
    if (!path.startsWith("/")) {
      throw new UsageError(`path: начинается с /, получено ${path}`);
    }
    return {
      host: this.host,
      path,
      url: `https://${this.host}${path}`,
      named: path,
    };
  }
}
