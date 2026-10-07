/**
 * Метод получателя глазами конверта: описанный (`DescribedMethod`) или
 * непонятый (`NotUnderstood`). Описанный ведёт вызов по порядку: ключи →
 * решение книги → исполнение → ответ своего вида.
 */

import type * as z from "zod";
import type { Described, Effect } from "./about.ts";
import {
	type Answer,
	type Enveloped,
	type Keys,
	Navigated,
	Value,
} from "./answer.ts";
import type { Context, Outcome } from "./context.ts";
import type { MethodDescription } from "./description.ts";
import { type EffectKind, effectOf, type Shelf } from "./effect.ts";
import { KeySet } from "./keys.ts";
import { declined, denied, notUnderstood } from "./refusal.ts";
import type { Admission, Followed, Rule } from "./rules.ts";

/** Где посылают сообщение: контекст и вход в результат-получатель. */
export interface Scene extends Context {
	/** Завернуть результат навигации `selector` тем же конвертом. */
	enter(selector: string, receiver: Described): Enveloped<unknown>;
}

/** Метод, которому посылают сообщение. */
export interface Method {
	send(args: Keys, scene: Scene): Promise<Answer>;
	/** Справка метода по пути получателя `path`. */
	help(path: readonly string[]): string;
}

/** Описание получателя в том виде, в каком его читает конверт. */
export interface AboutData {
	readonly comment: string;
	readonly methods: Readonly<Record<string, MethodData>>;
}

/** Класс-получатель в том виде, в каком его читает конверт. */
export interface ClassData {
	readonly about: AboutData;
	readonly name: string;
	readonly prototype: Described;
}

/** Пример в том виде, в каком его читает конверт. */
export interface ExampleData {
	readonly args?: Keys;
	readonly answer: unknown;
}

/** Описание метода в том виде, в каком его читает конверт. */
export interface MethodData {
	readonly comment: string;
	readonly effect?: Effect;
	readonly raises?: readonly string[];
	readonly deprecated?: { readonly use: string; readonly since: string };
	readonly args?: z.ZodObject;
	readonly secret?: readonly string[];
	readonly examples?: readonly ExampleData[];
	readonly returns?: "data" | ClassData;
}

/** Вид результата метода: данные или получатель. */
interface Returns {
	answer(result: unknown, selector: string, scene: Scene): Answer;
	/** Ответ примера словами справки. */
	shown(answer: unknown): string;
	/** Положить селектор на полку отражения. */
	file(shelf: Shelf, selector: string, effect: EffectKind): void;
	/** `"data"` или имя класса. */
	name(): string;
	/** Класс получателя-результата; данные — пусто. */
	classes(): ClassData[];
}

const DATA: Returns = {
	answer: (result) => new Value(result),
	shown: (answer) => JSON.stringify(answer),
	file: (shelf, selector, effect) => effect.file(shelf, selector),
	name: () => "data",
	classes: () => [],
};

class ReceiverReturns implements Returns {
	readonly #class: ClassData;

	constructor(receiverClass: ClassData) {
		this.#class = receiverClass;
	}

	answer(result: unknown, selector: string, scene: Scene): Answer {
		// Тип описания (`ReturnsPart`) требует класс-получатель ровно там, где
		// метод возвращает `Described`.
		return new Navigated(scene.enter(selector, result as Described));
	}

	shown(answer: unknown): string {
		return String(answer);
	}

	file(shelf: Shelf, selector: string): void {
		shelf.navigation(selector);
	}

	name(): string {
		return this.#class.name;
	}

	classes(): ClassData[] {
		return [this.#class];
	}
}

/** Вид результата из описания — данные автора на границе, один раз. */
function returnsOf(about: MethodData): Returns {
	return about.returns === undefined || about.returns === "data"
		? DATA
		: new ReceiverReturns(about.returns);
}

/** Запись журнала не сделана; `cause` — сбой журнала. */
export class JournalFailure extends Error {
	override readonly name = "JournalFailure";
}

/** Метод, описанный в `about` и найденный у получателя. */
export class DescribedMethod implements Method {
	readonly selector: string;
	readonly #about: MethodData;
	readonly #effect: EffectKind;
	readonly #keys: KeySet;
	readonly #returns: Returns;
	readonly #invoke: (args: Keys) => unknown;

	constructor(
		selector: string,
		about: MethodData,
		invoke: (args: Keys) => unknown,
	) {
		this.selector = selector;
		this.#about = about;
		this.#effect = effectOf(about.effect);
		this.#keys = new KeySet(about.args, about.secret);
		this.#returns = returnsOf(about);
		this.#invoke = invoke;
	}

	send(args: Keys, scene: Scene): Promise<Answer> {
		const path = this.#path(scene);
		return this.#keys
			.check(path, args)
			.proceed((valid) => this.#admit(valid, scene, path));
	}

	#admit(args: Keys, scene: Scene, path: string): Promise<Answer> {
		const call = new Call({
			method: this,
			args,
			scene,
			path,
			started: scene.clock.now(),
		});
		return scene.rules.rule(path).admit(call);
	}

	/** Исполнить метод получателя и ответить результатом своего вида. */
	async perform(args: Keys, scene: Scene): Promise<Answer> {
		return this.#returns.answer(await this.#invoke(args), this.selector, scene);
	}

	/** Правило, когда в книге для пути правила нет. */
	rule(): Rule {
		return this.#effect.rule();
	}

	/** Вопрос человеку: путь и ключи словами, секреты замаскированы. */
	question(path: string, args: Keys): string {
		return [path, this.#keys.words(args)]
			.filter((part) => part !== "")
			.join(" ");
	}

	/** Ключи для журнала. */
	logged(args: Keys): Keys {
		return this.#keys.logged(args);
	}

	/** Положить себя на полку отражения. */
	file(shelf: Shelf): void {
		this.#returns.file(shelf, this.selector, this.#effect);
	}

	/** Класс получателя, которого возвращает метод; данные — пусто. */
	classes(): ClassData[] {
		return this.#returns.classes();
	}

	/** Примеры как описаны (секреты открыты) — исполнять проверкой (в). */
	examples(): ExampleData[] {
		return structuredClone([...(this.#about.examples ?? [])]);
	}

	/** Находки (д): метод `at` записал в фейк `wrote` раз. */
	audit(at: string, wrote: number): string[] {
		return this.#effect.audit(at, wrote);
	}

	/** Находки (д): метод `at` без примера не проверить. */
	unverified(at: string): string[] {
		return (this.#about.examples ?? []).length === 0
			? this.#effect.unverified(at)
			: [];
	}

	help(receiverPath: readonly string[]): string {
		const path = [...receiverPath, this.selector].join(" ");
		const [head = "", ...when] = this.#about.comment.split("\n");
		const keys = this.#keys.lines();
		const { deprecated, raises = [], examples = [] } = this.#about;
		return [
			`${path} — ${head}`,
			...when,
			...(keys.length === 0 ? [] : [`ключи: ${keys.join("; ")}`]),
			...raises.map((raise) => `ошибка: ${raise}`),
			...(deprecated === undefined
				? []
				: [`устарел с ${deprecated.since} — зови ${deprecated.use}`]),
			...examples.map((example) => `пример: ${this.#example(path, example)}`),
		].join("\n");
	}

	#example(path: string, example: ExampleData): string {
		const call = this.question(path, example.args ?? {});
		return `${call} → ${this.#returns.shown(example.answer)}`;
	}

	describe(): MethodDescription {
		const about = this.#about;
		return {
			comment: about.comment,
			effect: this.#effect.name,
			returns: this.#returns.name(),
			args: this.#keys.json(),
			secret: this.#keys.secret(),
			raises: [...(about.raises ?? [])],
			deprecated:
				about.deprecated === undefined ? null : { ...about.deprecated },
			examples: (about.examples ?? []).map((example) =>
				this.#shownExample(example),
			),
		};
	}

	/** Пример данными: секреты в ключах замаскированы, как в журнале. */
	#shownExample(example: ExampleData): ExampleData {
		const answer = structuredClone(example.answer);
		return example.args === undefined
			? { answer }
			: { args: this.#keys.logged(example.args), answer };
	}

	#path(scene: Scene): string {
		return [...scene.path, this.selector].join(" ");
	}
}

interface CallParts {
	readonly method: DescribedMethod;
	readonly args: Keys;
	readonly scene: Scene;
	readonly path: string;
	readonly started: number;
}

/** Вызов с проверенными ключами, ждущий решения книги. */
class Call implements Admission, Followed {
	readonly #parts: CallParts;

	constructor(parts: CallParts) {
		this.#parts = parts;
	}

	/**
	 * Исполнить и записать исход. Сбой журнала после исполнения — ошибка с
	 * пометкой, что вызов исполнен: запись в домене уже произошла.
	 */
	async perform(): Promise<Answer> {
		const { method, args, scene } = this.#parts;
		const answer = await method
			.perform(args, scene)
			.catch((error: unknown) => this.#failed(error));
		await this.#journal("ok", "вызов исполнен");
		return answer;
	}

	/** Метод бросил: записать `error` и бросить дальше, не потеряв ни одну ошибку. */
	async #failed(error: unknown): Promise<never> {
		await this.#journal("error", "метод бросил").catch((journal: unknown) => {
			throw new AggregateError(
				[error, journal],
				`${this.#parts.path}: метод бросил, запись журнала не сделана`,
			);
		});
		throw error;
	}

	async deny(): Promise<Answer> {
		await this.#journal("denied");
		return denied(this.#parts.path);
	}

	async ask(): Promise<Answer> {
		const { method, args, scene, path } = this.#parts;
		const reply = await scene.asker.ask(method.question(path, args), {
			signal: scene.signal,
		});
		return reply.follow(this);
	}

	inherit(): Promise<Answer> {
		return this.#parts.method.rule().admit(this);
	}

	async decline(): Promise<Answer> {
		await this.#journal("declined");
		return declined(this.#parts.path);
	}

	/** Записать исход; сбой журнала — `JournalFailure` с путём, исходом и `note`. */
	async #journal(outcome: Outcome, note = "вызов не исполнен"): Promise<void> {
		const { method, args, scene, path, started } = this.#parts;
		await scene.journal
			.write({
				path,
				args: method.logged(args),
				outcome,
				ms: scene.clock.now() - started,
			})
			.catch((cause: unknown) => {
				throw new JournalFailure(`journal ${path} ${outcome}: ${note}`, {
					cause,
				});
			});
	}
}

/** Сообщение, которого получатель не понимает: отвечает отказом. */
export class NotUnderstood implements Method {
	readonly #word: string;
	readonly #known: readonly string[];

	constructor(word: string, known: readonly string[]) {
		this.#word = word;
		this.#known = known;
	}

	async send(_args: Keys, scene: Scene): Promise<Answer> {
		return notUnderstood(scene.path, this.#word, this.#known);
	}

	help(path: readonly string[]): string {
		return notUnderstood(path, this.#word, this.#known).text();
	}
}
