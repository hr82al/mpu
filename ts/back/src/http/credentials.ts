/**
 * Адрес прокси для текста отказа: учётные данные (`user:password@`) не
 * попадают в вывод ни при каком отказе — ни разбора адреса, ни клиента
 * HTTP (`docs/specs/platform/telegram-questions.md`, «Уточнения R1a»;
 * `telegram send`, «Инварианты»). Хост и порт остаются: по ним человек
 * узнаёт, какой прокси не годится.
 */

/**
 * URL без учётных данных. Разобранный URL пересобирается из частей, и
 * `username`/`password` в них не попадают вовсе; хвост режется по
 * ПОСЛЕДНЕМУ «@» — по первому отрезался бы пароль с литеральным «@»
 * внутри, а нестандартная форма («socks5:/user:pass@host») и
 * неразбираемый адрес кладут учётные данные в путь или в сам текст.
 *
 * @param raw адрес прокси как записан
 */
export function withoutCredentials(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Адрес не разбирается — режется сам текст: всё до последнего «@»
    // может оказаться паролем.
    return afterLastAt(raw);
  }
  return `${url.protocol}//${afterLastAt(`${url.host}${url.pathname}`)}`;
}

function afterLastAt(text: string): string {
  return text.slice(text.lastIndexOf("@") + 1);
}
