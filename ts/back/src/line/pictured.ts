/**
 * Картинка результата — галерее строки (`platform/picture-frame.md`):
 * предлагается в момент доставки результата, читается в конце строки.
 */

import type { Delivery } from "../entrypoint/mod.ts";
import type { Picture } from "../picture/mod.ts";

/** Куда строка складывает картинки результатов. */
export interface Pictures {
  offer(picture: Picture): void;
}

/**
 * Доставка, предлагающая картинку результата: код 0 — его картинка в
 * `pictures`; прочее — как у `inner`. Неуспешный результат картинки не
 * даёт: блок без итога сбил бы агента.
 */
export function picturing(inner: Delivery, pictures: Pictures): Delivery {
  return {
    deliver(command, result, args, json, output) {
      const code = inner.deliver(command, result, args, json, output);
      if (code === 0) pictures.offer(command.picture(result));
      return code;
    },
  };
}
