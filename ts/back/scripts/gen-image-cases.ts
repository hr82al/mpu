/**
 * Пересборка голденов образа `src/line/testdata/image/`
 * (`docs/specs/platform/image.md`, «Golden-примеры»): снимок `kiten
 * messages` и справки метода после определения — прогоном на стенде.
 *
 *   bun back/scripts/gen-image-cases.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { IMAGE_DIR, imageGoldens } from "../src/line/testimage.ts";

await mkdir(IMAGE_DIR, { recursive: true });
const taken = await imageGoldens();
for (const [name, text] of Object.entries(taken)) {
  await writeFile(new URL(name, IMAGE_DIR), text);
}
console.log(`файлов: ${Object.keys(taken).length}`);
