/**
 * Кадры WebSocket (RFC 6455) — ровно столько, сколько нужно стриму
 * `docker exec` через Portainer (`platform/exec-transport.md`, п. 5):
 * приём данных, ответ на ping, свой ping в простое и закрытие.
 *
 * Свой кодек, а не встроенный `WebSocket`: тот не умеет ни заголовка
 * `X-API-Key` в рукопожатии, ни отправки ping — а спека требует обоих.
 * Кодеком пользуются обе стороны, клиент и фейковый сервер тестов, —
 * иначе проверять поведение было бы нечем.
 */

/** Коды операций, которые встречаются на этом стриме. */
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** Разобранный кадр; фрагментацию склеивает вызывающий. */
export interface WsFrame {
  readonly opcode: number;
  readonly fin: boolean;
  readonly payload: Uint8Array;
}

/** Разбор кадра и остаток буфера; кадр не дочитан — `null`. */
export interface FrameCut {
  readonly frame: WsFrame;
  readonly rest: Uint8Array;
}

/**
 * Кадр клиента: маскирование обязательно (RFC 6455, §5.3), ключ —
 * параметр, чтобы кодирование оставалось чистой функцией и
 * проверялось сравнением.
 */
export function encodeFrame(
  opcode: number,
  payload: Uint8Array,
  mask: Uint8Array,
): Uint8Array {
  const header = lengthBytes(payload.length);
  const frame = new Uint8Array(1 + header.length + 4 + payload.length);
  frame[0] = 0x80 | opcode;
  frame.set(header, 1);
  // Бит маски — старший в байте длины; сама длина уже разложена.
  frame[1] |= 0x80;
  const maskAt = 1 + header.length;
  frame.set(mask, maskAt);
  for (let i = 0; i < payload.length; i++) {
    frame[maskAt + 4 + i] = payload[i] ^ mask[i % 4];
  }
  return frame;
}

/** Первый кадр буфера; данных не хватает — `null`, буфер копится дальше. */
export function decodeFrame(buffer: Uint8Array): FrameCut | null {
  if (buffer.length < 2) return null;
  const masked = (buffer[1] & 0x80) !== 0;
  const short = buffer[1] & 0x7f;
  const extra = short === 126 ? 2 : short === 127 ? 8 : 0;
  const lengthAt = 2;
  if (buffer.length < lengthAt + extra) return null;
  const length = extra === 0
    ? short
    : Number(readLength(buffer.subarray(lengthAt, lengthAt + extra)));
  const maskAt = lengthAt + extra;
  const dataAt = maskAt + (masked ? 4 : 0);
  if (buffer.length < dataAt + length) return null;

  const raw = buffer.subarray(dataAt, dataAt + length);
  const payload = masked
    ? unmask(raw, buffer.subarray(maskAt, maskAt + 4))
    : raw.slice();
  return {
    frame: { opcode: buffer[0] & 0x0f, fin: (buffer[0] & 0x80) !== 0, payload },
    rest: buffer.subarray(dataAt + length),
  };
}

/** Случайный ключ маскирования: RFC требует непредсказуемого. */
export function randomMask(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(4));
}

function unmask(payload: Uint8Array, mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
  return out;
}

/** Длина в форме, которую требует её величина: 7, 7+16 или 7+64 бита. */
function lengthBytes(length: number): Uint8Array {
  if (length < 126) return Uint8Array.of(length);
  if (length < 0x1_00_00) {
    return Uint8Array.of(126, (length >> 8) & 0xff, length & 0xff);
  }
  const out = new Uint8Array(9);
  out[0] = 127;
  new DataView(out.buffer).setBigUint64(1, BigInt(length));
  return out;
}

function readLength(bytes: Uint8Array): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes.length === 2 ? BigInt(view.getUint16(0)) : view.getBigUint64(0);
}
