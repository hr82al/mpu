/** Откуда компоненты берут `fetch` и адрес `back`: тесты подставляют свой. */

import { createContext, useContext } from "react";
import type { Transport } from "./api.ts";

export const TransportContext = createContext<Transport>({
  fetch: (...args) => fetch(...args),
  base: globalThis.location?.origin ?? "",
});

export function useTransport(): Transport {
  return useContext(TransportContext);
}
