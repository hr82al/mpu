/**
 * Ключ `mpu config` `image.dir` (`platform/config.md`, «Ключ `image.dir`»):
 * каталог файлов образа. Объявляет его тот, кто значение применяет, —
 * строки `image sync` и `image export` (`sync.ts`); его умолчание — и
 * граница права записи строки (`image-sync.md`): каталог — оно или под
 * ним. Отдельным модулем: реестр собирает список ключей, а `sync.ts`
 * сам берёт реестр через дерево строки — импорт оттуда замкнул бы цикл.
 */

import { type ConfigKey, underHome } from "@mpu/command/config";

/** Каталог файлов образа; умолчание — под `HOME`. */
export const IMAGE_DIR: ConfigKey = {
  key: "image.dir",
  type: "str",
  fallback: underHome("mr/mp/mpu/image"),
  description:
    "Каталог файлов методов образа для `mpu image sync` и `mpu image export`",
};
