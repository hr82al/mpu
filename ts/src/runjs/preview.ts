/**
 * Блок `--dry-run` (`specs/run-js.md`, «CLI-контракт»): команда, которой
 * ушёл бы код, — в том виде, в каком её можно скопировать и выполнить
 * руками. Отсюда here-doc: код уезжает на stdin, а не аргументом.
 */

/** Маркер here-doc; в кавычках, чтобы шелл не трогал содержимое. */
const EOF_MARK = "__MPU_RUN_JS_EOF__";

/**
 * Текст превью для таргетов. При нескольких таргетах перед каждым
 * блоком печатается его метка — иначе блоки неразличимы.
 */
export function previewOf(
  labels: readonly string[],
  code: string,
): string {
  const body = code.replace(/\n+$/, "");
  return labels
    .map((label) => {
      const block = `mpu ssh ${label} -- node --input-type=module -` +
        ` <<'${EOF_MARK}'\n${body}\n${EOF_MARK}\n`;
      return labels.length > 1 ? `# target=${label}\n${block}` : block;
    })
    .join("");
}
