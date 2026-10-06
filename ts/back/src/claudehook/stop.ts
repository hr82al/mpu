/**
 * Payload хука `Stop` → вопрос «ждёт ввода» (`claude-hook-stop.md`,
 * «Ввод», «Вопрос „ждёт ввода“», «Вывод»). Разбор — граница чужого
 * формата: поля payload'а читаются здесь и только здесь.
 */

import { Form, KEEP_TAIL, ONE, WAITS_INPUT } from "../botquestions/mod.ts";
import { STOP } from "../frames/mod.ts";
import { type Fields, isFields } from "./fields.ts";
import { projectOf } from "./places.ts";
import type { Reach } from "./reach.ts";
import { DECIDED, type HookReply, type HookSpeech } from "./reply.ts";
import {
  type Sign,
  type Transcript,
  type Transcripts,
  UNREAD,
} from "./transcript.ts";

/** Вопрос поставлен: хуку сказать нечего — stdout и stderr пусты. */
export const QUIET: HookReply = { tell: () => {}, code: DECIDED };

/** Вопрос не поставлен: одна строка в stderr. */
export class NoQuestion implements HookReply {
  readonly #reason: string;

  /** @param reason причина из списка спеки («Вывод») */
  constructor(reason: string) {
    this.#reason = reason;
  }

  code = DECIDED;

  tell(speech: HookSpeech) {
    speech.stderr(STOP.undecided(this.#reason));
  }
}

/** Причина: хук сработал на продолжении хода, которое сам вызвал [S8]. */
export const CONTINUING = "продолжение хода";

/**
 * Форма «ждёт ввода»: голова — `💬` и первое место (название сессии,
 * иначе проект, иначе `сессия`), остальные места — за ` — `; текст —
 * последнее сообщение сессии, при усечении остаётся конец.
 */
export function waitingForm(
  places: readonly string[],
  message: string,
  reach: Reach,
): Form {
  const [first = "сессия", ...rest] = places;
  const said = message === "" ? "(без текста)" : message;
  return new Form({
    places: rest,
    kind: WAITS_INPUT,
    steps: [{
      head: `💬 ${first}`,
      text: [said, ...reach.tail].join("\n"),
      options: [],
      choice: ONE,
      reply: reach.reply,
      clip: KEEP_TAIL,
    }],
    actions: reach.actions,
  });
}

/** Транскрипт сессии: назван payload'ом или нет. */
export interface TranscriptAt {
  /** Транскрипт, наблюдаемый до признака `sign`. */
  read(transcripts: Transcripts, sign: Sign): Promise<Transcript>;
}

/** Транскрипт не назван: ни названия, ни снятия по нему. */
const UNNAMED: TranscriptAt = { read: () => Promise.resolve(UNREAD) };

/** Разобранный payload `Stop`. */
export interface StopRequest {
  /** `last_assistant_message`. */
  readonly message: string;
  readonly transcript: TranscriptAt;
  /** Место «проект»: базовое имя `cwd`; нет — пусто. */
  readonly project: readonly string[];
}

/** Чтение исхода разбора. */
export interface StopReader<T> {
  /** Требование таблицы «Ввод» нарушено: `what` — какое. */
  unparsed(what: string): T;
  /** Продолжение хода (`stop_hook_active`) — вопроса нет. */
  continuing(): T;
  parsed(request: StopRequest): T;
}

/** Исход разбора stdin. */
export interface StopPayload {
  read<T>(reader: StopReader<T>): T;
}

function unparsed(what: string): StopPayload {
  return { read: (reader) => reader.unparsed(what) };
}

const NOT_OBJECT = unparsed("stdin — не JSON-объект");

const CONTINUING_PAYLOAD: StopPayload = {
  read: (reader) => reader.continuing(),
};

/** Транскрипт по полю `transcript_path`; не строка — не назван. */
function transcriptAt(payload: Fields): TranscriptAt {
  const path = payload.transcript_path;
  if (typeof path !== "string") return UNNAMED;
  return { read: (transcripts, sign) => transcripts.read(path, sign) };
}

/**
 * Разбор stdin хука по таблице «Ввод»: требования сверху вниз, первое
 * нарушенное — причина; незнакомые поля игнорируются.
 *
 * @param text stdin целиком
 */
export function stopPayloadOf(text: string): StopPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return NOT_OBJECT;
  }
  if (!isFields(payload)) return NOT_OBJECT;
  if (payload.stop_hook_active === true) return CONTINUING_PAYLOAD;
  const message = payload.last_assistant_message;
  if (typeof message !== "string") {
    return unparsed("нет last_assistant_message");
  }
  const request: StopRequest = {
    message,
    transcript: transcriptAt(payload),
    project: projectOf(payload.cwd),
  };
  return { read: (reader) => reader.parsed(request) };
}
