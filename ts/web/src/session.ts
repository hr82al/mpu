/**
 * Вход по ссылке `mpu web` (`specs/web.md`, «Вход в браузере»):
 * ключ из адреса меняется на сессию, и ключ из адреса убирается — в
 * истории и закладках его не остаётся.
 */

import { exchangeKey, type Transport } from "./api.ts";

/** Адрес страницы и история браузера — то, что трогает вход. */
export interface Place {
  readonly href: string;
  replace(url: string): void;
}

/** Ключ из адреса → сессия; ключ убран из адреса. Ключа нет — ничего. */
export async function enter(place: Place, transport: Transport): Promise<void> {
  const url = new URL(place.href);
  const key = url.searchParams.get("key");
  if (key === null) return;
  url.searchParams.delete("key");
  place.replace(`${url.pathname}${url.search}${url.hash}`);
  await exchangeKey(transport, key);
}
