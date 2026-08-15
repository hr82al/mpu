/**
 * Текстовая часть комментария к карточке (`docs/specs/kiten-comment.md`):
 * адресаты, раскрытие `@all` и сборка итогового текста. Всё здесь —
 * чистые преобразования строк: сети они не касаются и проверяются
 * таблицей случаев, а не стендом.
 */

/** Токен `@all` сам по себе: не часть слова и не хвост адреса почты. */
const ALL_TOKEN = /(?<![\w.@])@all(?![\w.@])/i;

/** Тот же токен для замены всех вхождений сразу. */
const EVERY_ALL_TOKEN = new RegExp(ALL_TOKEN.source, "gi");

/**
 * Есть ли в тексте самостоятельный `@all`. По нему команда решает, нужен
 * ли ей владелец карточки, — и только поэтому ходит за карточкой.
 */
export function mentionsAll(text: string): boolean {
  return ALL_TOKEN.test(text);
}

/** Раскрывает `@all` в тексте в адресата-владельца. */
export function expandAllInText(text: string, ownerHandle: string): string {
  return text.replace(EVERY_ALL_TOKEN, ownerHandle);
}

/**
 * Токены адресатов из значений `--to`: каждое значение делится по
 * пробелам, токен без ведущего `@` его получает. Отдельно от раскрытия
 * и дедупа, потому что по НАЛИЧИЮ токенов решается и то, нужен ли
 * комментарию свой текст, и то, читать ли карточку: `--to ''` — флаг
 * есть, а адресатов нет.
 */
export function recipientTokens(
  values: readonly string[],
): readonly string[] {
  return values.flatMap((value) =>
    value.split(/\s+/).filter(Boolean).map((token) =>
      token.startsWith("@") ? token : `@${token}`
    )
  );
}

/**
 * Адресаты: `@all` разворачивается во владельца (`null` — владельца нет,
 * токен остаётся литеральным), дубликаты убираются без учёта регистра с
 * сохранением первого вхождения. Раскрытие идёт до дедупа — иначе
 * `--to '@ivanov @all'` дал бы одного владельца дважды.
 */
export function recipientsFrom(
  tokens: readonly string[],
  ownerHandle: string | null,
): readonly string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const token of tokens) {
    const handle = expand(token, ownerHandle);
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(handle);
  }
  return recipients;
}

/**
 * Итоговый текст комментария: строка адресатов первой, затем пустая
 * строка, затем текст. Текста нет — комментарий из одной строки
 * адресатов; адресатов нет — один текст.
 */
export function commentText(
  recipients: readonly string[],
  body: string,
): string {
  if (recipients.length === 0) return body;
  const line = recipients.join(" ");
  return body === "" ? line : `${line}\n\n${body}`;
}

function expand(handle: string, ownerHandle: string | null): string {
  if (ownerHandle === null) return handle;
  return handle.toLowerCase() === "@all" ? ownerHandle : handle;
}
