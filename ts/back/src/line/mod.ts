/**
 * Исполнение строки (`platform/registry-objects.md`): строка вызова
 * исполняется цепочкой сообщений по дереву реестра, а команду исполняет
 * нынешняя диспетчеризация, получая исходную строку целиком, — если
 * позволяют правила подтверждения (`platform/policy.md`).
 */

import type { CommandIo } from "@mpu/command";
import {
  type HookReply,
  NO_DESK,
  NO_ELICITATION_DESK,
  NO_NOTIFY_DESK,
  NO_STOP_DESK,
} from "@mpu/cmd-claudehook";
import {
  consentAt,
  type Invoker,
  type Output,
  PRINT,
  runLine,
  streams,
} from "../entrypoint/mod.ts";
import type { RefusalData } from "@mpu/language/frames";
import { UNNAMED_REFUSAL } from "@mpu/language/messages";
import { plainRefusal, runChain } from "@mpu/language/objects";
import {
  type Channel,
  Human,
  NOBODY,
  PolicyError,
  type RuleBook,
  type RuleEntry,
} from "@mpu/command/policy";
import type { CliEntry } from "../process/mod.ts";
import { programCommands, programPolicy, programRoot } from "./program.ts";
import { strippedOf, walkedWords } from "./walked.ts";
import { openRegistryBook } from "./seeds.ts";
import { targetValues } from "@mpu/command/selector";
import { itMethod, type Memory, NO_CALLER, remembering } from "./it.ts";
import { type Pictures, picturing } from "./pictured.ts";
import { printed, type Speech } from "./printed.ts";
import { Session } from "./session.ts";
export { HUMAN_ONLY } from "./session.ts";
import { LineValues, StdinOnce } from "./value.ts";
import { entryOf, toDoor } from "./view.ts";
import { type RootMethod, rootMethod } from "./rules.ts";
import { registryNodes, registryRoot, ruleLinks } from "./tree.ts";
import { Image, ImageError, type ImageMethod } from "@mpu/cmd-image";
import type { Line } from "./dispatch.ts";
import { LineConsulting } from "./consulting.ts";
import type { OwnerHooks } from "./hook.ts";
import { routeOf } from "./route.ts";
import { formerOf } from "./former.ts";

export type { RootMethod } from "./rules.ts";
export { LastResults, type Memory, NO_CALLER } from "./it.ts";

export { registryNodes, type TreeNode } from "./tree.ts";
export { protocolMessages, selectionMessages } from "@mpu/language/objects";

/** Действующее решение узла дерева (`specs/web.md`, «Действующие решения»). */
export interface NodeRuling {
  readonly path: readonly string[];
  readonly verdict: string;
  /** Путь правила-победителя; ни одно не совпало — `null`. */
  readonly rule: string | null;
  /** У самого узла есть своё правило. */
  readonly own: boolean;
}

/**
 * Решения для узлов снимка — тем же набором правил, что решает строки:
 * путь узла с хвостом — со звеном `<args>`.
 *
 * @throws PolicyError — файл правил нельзя открыть или прочитать
 */
export function policyTree(
  file: string | undefined,
  image: readonly ImageMethod[] = [],
): NodeRuling[] {
  using book = openRegistryBook(file);
  const owned = new Set(book.list().map((rule) => rule.path));
  return registryNodes(image).map((node) => {
    const { verdict, won } = book.decide(ruleLinks(node)).record();
    const own = owned.has(node.path.length === 0 ? "*" : node.path.join(" "));
    return { path: node.path, verdict, rule: won, own };
  });
}

/**
 * Вопросы владельцу строк-хуков: stdin и сигнал обрыва строки; окружение
 * клиента привязывает дверь строки.
 */
export interface OwnerAsking {
  /** Хук `PermissionRequest` (`claude-hook-permission-request.md`). */
  permission(text: string, signal: AbortSignal): Promise<HookReply>;
  /**
   * Хук `Stop` (`claude-hook-stop.md`): вопрос переживает строку, обрыв
   * её не касается.
   */
  stop(text: string): Promise<HookReply>;
  /** Хук `Notification` (`claude-hook-notification-snapshot.md`). */
  notification(text: string): Promise<HookReply>;
  /** Хук `Elicitation` (`claude-hook-elicitation.md`). */
  elicitation(text: string, signal: AbortSignal): Promise<HookReply>;
}

/** Вопроса задать некому: окружения клиента нет, бот не настроен. */
const UNASKED: OwnerAsking = {
  permission: (text, signal) => NO_DESK.reply(text, () => undefined, signal),
  stop: (text) => NO_STOP_DESK.reply(text, () => undefined),
  notification: (text) => NO_NOTIFY_DESK.reply(text, () => undefined),
  elicitation: (text, signal) =>
    NO_ELICITATION_DESK.reply(text, () => undefined, signal),
};

/** Кто спрашивает подтверждение у строки. */
export type ChannelOf = (io: CommandIo, output: Output) => Channel;

/** Чем точка входа отличается от соседей: правила, вопрос, исполнение. */
export interface LinePorts {
  /** Файл правил; каталога состояния нет — `undefined`. */
  readonly file: string | undefined;
  readonly channel: ChannelOf;
  /**
   * Исполнение строки нынешней диспетчеризацией. Разбор, решение правил и
   * вопрос — до него: у сервера строк оно идёт в очереди, и строка,
   * ждущая ответа, других не держит.
   */
  readonly execute: (run: () => Promise<number>) => Promise<number>;
  /**
   * Где исполняется сама команда: у сервера строк — исполнитель из пула
   * (`platform/line-executor.md`), у прочих — `IN_PLACE`.
   */
  readonly invoker: Invoker;
  /** Методы корня, которые даёт дверь строки (у прямого — нет). */
  readonly rootMethods: readonly RootMethod[];
  /** Память вызывающего строки: её результат и ответ на `it`. */
  readonly memory: Memory;
  /**
   * Отказ строки объектом — вызывающему, перед его текстом в stderr
   * (`platform/refusal-object.md`); у прямого вызова объект не нужен.
   */
  readonly refusal: (data: RefusalData) => void;
  /** Образ строки (`platform/image.md`); нет — образ пуст, писать некуда. */
  readonly image?: ImagePorts;
  /**
   * Картинки результатов строки (`platform/picture-frame.md`): их кадры
   * отдаёт дверь перед `exit`. Нет — картинки читать некому.
   */
  readonly pictures?: Pictures;
  /** Вопросы владельцу строк-хуков. Нет — бот не настроен. */
  readonly owner?: OwnerAsking;
}

/** Образ строки: файл, кто пишет, часы и снимок дерева. */
export interface ImagePorts {
  /** Файл образа; живёт дольше строки — сверка `data_version` у него. */
  readonly image: Image;
  /** Канал автора определения: `human`, `agent`, `web`. */
  readonly author: string;
  readonly now: () => Date;
  /** Образ изменился: снимок дерева переписывается. */
  readonly changed: () => Promise<void>;
}

/** Образа нет: пуст, запись — отказ «нет HOME». */
function noImage(): ImagePorts {
  return {
    image: Image.at(undefined),
    author: "human",
    now: () => new Date(),
    changed: () => Promise.resolve(),
  };
}

/** Картинки строки читать некому: у двери нет кадра для них. */
const UNSEEN: Pictures = { offer() {} };

/** Отказ-объект никому не нужен: достаточно текста. */
export const NO_REFUSAL = (_data: RefusalData) => {};

/**
 * Файл правил в каталоге состояния (`platform/policy.md`, «Хранение»).
 *
 * @param stateDir каталог состояния; `undefined` — нет HOME
 */
export function policyFile(stateDir: string | undefined): string | undefined {
  return stateDir === undefined ? undefined : `${stateDir}/policy.db`;
}

/**
 * Канал терминала: человек — только когда и stdin, и stderr терминалы;
 * вопрос — в stderr, ответ — строка stdin.
 *
 * @param readLine одна строка ответа из stdin; конец ввода — `undefined`
 */
export function terminalChannel(
  readLine: () => Promise<string | undefined>,
): ChannelOf {
  return (io, output) => {
    if (!io.stdinIsTerminal() || !io.stderrIsTerminal()) return NOBODY;
    return new Human(output.stderr, readLine);
  };
}

/**
 * Правила файла — те же данные, что у строки `policy`
 * (`platform/policy.md`), с посевом на открытии.
 *
 * @throws PolicyError — файл нельзя открыть или прочитать
 */
export function rulesOf(file: string | undefined): RuleEntry[] {
  using book = openRegistryBook(file);
  return book.list();
}

/** Прямое исполнение: строка одна, ждать места не у кого. */
export function immediately(run: () => Promise<number>): Promise<number> {
  return run();
}

/**
 * Исполняет строку вызова и возвращает код завершения. Файл правил
 * открывается до разбора строки — нечитаемый файл отказывает любой
 * строке, включая справку.
 *
 * @param ports файл правил, канал вопроса и исполнение
 */
export function lineEntry(ports: LinePorts): CliEntry {
  return async (argv, io, output, journal) => {
    const speech: Speech = {
      stdout: (text) => output.stdout(text),
      stderr: (text) => output.stderr(text),
      refusal: ports.refusal,
    };
    let book: RuleBook;
    try {
      book = openRegistryBook(ports.file);
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      plainRefusal(UNNAMED_REFUSAL, err.message).tell(speech);
      return 1;
    }
    using _book = book;
    const imaging = ports.image ?? noImage();
    const pictures = ports.pictures ?? UNSEEN;
    let methods: readonly ImageMethod[];
    try {
      methods = imaging.image.methods();
    } catch (err) {
      if (!(err instanceof ImageError)) throw err;
      plainRefusal(UNNAMED_REFUSAL, err.message).tell(speech);
      return 1;
    }
    const sources = methods.map((method) => method.source());
    const walked = walkedWords(argv);
    // Строка через дверь объявляет запись для всей строки: группы
    // значений идут той же дверью (`platform/value-expression.md`).
    const typedEntry = entryOf(walked);
    // Прежняя форма отказывает раньше всего, что строка читает сама:
    // ввода и маршрута (`platform/stage6-l1.md`).
    const door = typedEntry.words;
    const said = walked.slice(door.length);
    return await formerOf(argv, said).settle(
      { io, speech, journal },
      async () => {
        // stdin строки — один источник: ключом `stdin` и прежней подстановкой.
        const stdin = new StdinOnce(io);
        const lineIo: CommandIo = {
          ...io,
          readStdin: () => stdin.forCommand(),
        };
        const channel = ports.channel(io, output);
        const parts = {
          own: [
            ...ports.rootMethods.map(rootMethod),
            itMethod(ports.memory, output.stderr),
          ],
          targets: (like: string) => {
            using db = io.openCacheDb();
            return Promise.resolve(targetValues(db, like));
          },
          image: methods,
        };
        /**
         * Строка `words` с выводом `out`: её собственная сессия; результат
         * команды запоминает `memory`.
         */
        const sessionOf = (
          words: readonly string[],
          out: Speech,
          memory: Memory,
        ) =>
          new Session({
            book,
            channel,
            output: out,
            dispatch: (view, order, delivery) =>
              ports.execute(() =>
                runLine(
                  order.argv(view.executed(words)),
                  lineIo,
                  out,
                  journal,
                  picturing(remembering(delivery ?? PRINT, memory), pictures),
                  ports.invoker,
                ),
              ),
            streams: (view, order) => streams(order.argv(view.executed(words))),
            consent: (view, order) =>
              consentAt(order.argv(view.executed(words))),
            terminal: io.stdinIsTerminal(),
            redirect: () => toDoor(),
          });
        const values: LineValues = new LineValues(async (words) => {
          const texts: string[] = [];
          const captured: Speech = {
            stdout: (text) => void texts.push(text),
            stderr: speech.stderr,
            refusal: speech.refusal,
          };
          const group = [...door, ...words];
          // Результат группы — значение ключа, а не результат строки.
          const root = registryRoot(
            sessionOf(group, captured, NO_CALLER),
            book,
            parts,
          );
          const outcome = await runChain(group, root, values);
          return { outcome, printed: texts.join("") };
        }, stdin);
        /** Корень строки, чью сессию `wrap` может подменить. */
        const rootOf = (wrap: (session: Line) => Line) =>
          registryRoot(wrap(sessionOf(argv, speech, ports.memory)), book, {
            ...parts,
            stripped: strippedOf(argv),
          });
        const root = rootOf((session) => session);
        const commands = programCommands(sources);
        /**
         * Порты строк-хуков: их stdin, проба той же строки и вопрос владельцу
         * — с окружением клиента и сигналом обрыва строки.
         */
        const asking = ports.owner ?? UNASKED;
        const owner: OwnerHooks = {
          permission: (text) => asking.permission(text, lineIo.signal),
          stop: (text) => asking.stop(text),
          notification: (text) => asking.notification(text),
          elicitation: (text) => asking.elicitation(text, lineIo.signal),
        };
        const hook = {
          readStdin: lineIo.readStdin,
          owner,
          consulting: new LineConsulting({
            book,
            methods,
            rootMethods: ports.rootMethods,
            targets: parts.targets,
            readStdin: lineIo.readStdin,
            owner,
          }),
        };
        const context = {
          said,
          view: typedEntry.view,
          book,
          channel,
          speech,
          image: imaging.image,
          methods,
          commands,
          root: programRoot(root),
          author: imaging.author,
          now: imaging.now,
          changed: imaging.changed,
          journaled: () => journal.nativeCall(programPolicy(said)),
          io: lineIo,
          walk: async (
            wrap: (session: Line, words: readonly string[]) => Line,
          ) =>
            printed(
              await runChain(
                walked,
                rootOf((session) => wrap(session, argv)),
                values,
              ),
              speech,
            ),
        };
        return await routeOf(said, hook).settle(context, () =>
          runChain(walked, root, values).then((outcome) =>
            printed(outcome, speech),
          ),
        );
      },
    );
  };
}
