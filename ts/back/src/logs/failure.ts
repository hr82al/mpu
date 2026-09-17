/**
 * Тексты отказов внешних источников (`docs/specs/logs.md`, «Граничные
 * случаи и ошибки»): ответ Loki вне 2xx, сетевой сбой и отказ Portainer.
 * Отдельно от исполнения, потому что теми же текстами отчитывается
 * слежение — оно печатает отказ опроса и продолжает работу.
 *
 * Отказ, пришедший не от источника, не переводится, а возвращается как
 * есть: подменять чужую ошибку своим текстом — терять причину.
 */

import { DomainError } from "../command/mod.ts";
import { LokiError, LokiHttpError } from "../loki/mod.ts";
import { PortainerError } from "../portainer/mod.ts";

/** Сколько символов тела ответа попадает в текст ошибки. */
const BODY_LIMIT = 500;

/** Отказ Loki в доменную ошибку; LogQL уходит второй строкой. */
export function lokiFailure(err: unknown, logql: string): unknown {
  if (err instanceof LokiHttpError) {
    return new DomainError(
      `loki HTTP ${err.status}: ${err.body.trim().slice(0, BODY_LIMIT)}`,
      { details: `  query: ${logql}`, cause: err },
    );
  }
  if (err instanceof LokiError) {
    return new DomainError(`loki error: ${err.message}`, { cause: err });
  }
  return err;
}

/** Отказ Portainer в доменную ошибку. */
export function portainerFailure(err: unknown): unknown {
  if (err instanceof PortainerError) {
    return new DomainError(`portainer error: ${err.message}`, { cause: err });
  }
  return err;
}
