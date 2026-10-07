/**
 * Конверт: получатель, до которого снаружи доходит только описанное.
 * Порядок проверок: отмена → понимание → ключи → решение книги →
 * исполнение (`method.ts`).
 */

import type { Described, Selectors } from "./about.ts";
import type { Answer, Enveloped, Keys } from "./answer.ts";
import type { Context } from "./context.ts";
import type { Description, SelectorGroups } from "./description.ts";
import type { Scene } from "./method.ts";
import { Protocol } from "./protocol.ts";
import { cancelled } from "./refusal.ts";

/** Завернуть получатель `receiver` в конверт с контекстом `ctx`. */
export function envelope<T extends Described>(
	receiver: T,
	ctx: Context,
): Enveloped<T> {
	return new Envelope(receiver, new Place(ctx));
}

class Place implements Scene {
	readonly path: readonly string[];
	readonly rules: Context["rules"];
	readonly journal: Context["journal"];
	readonly asker: Context["asker"];
	readonly clock: Context["clock"];
	readonly signal: AbortSignal;

	constructor(ctx: Context) {
		this.path = [...ctx.path];
		this.rules = ctx.rules;
		this.journal = ctx.journal;
		this.asker = ctx.asker;
		this.clock = ctx.clock;
		this.signal = ctx.signal;
	}

	enter(selector: string, receiver: Described): Enveloped<unknown> {
		return envelope(receiver, {
			path: [...this.path, selector],
			rules: this.rules,
			journal: this.journal,
			asker: this.asker,
			clock: this.clock,
			signal: this.signal,
		});
	}
}

class Envelope<T extends Described> implements Enveloped<T> {
	readonly #receiver: T;
	readonly #protocol: Protocol;
	readonly #scene: Place;

	constructor(receiver: T, scene: Place) {
		this.#receiver = receiver;
		this.#protocol = Protocol.of(receiver);
		this.#scene = scene;
	}

	async send(
		selector: Selectors<T> | (string & {}),
		args: Keys = {},
	): Promise<Answer> {
		const scene = this.#scene;
		if (scene.signal.aborted) {
			return cancelled([...scene.path, selector].join(" "));
		}
		return this.#protocol.lookup(selector).send(args, scene);
	}

	describe(): Description {
		return { path: this.#scene.path.join(" "), ...this.#protocol.describe() };
	}

	selectors(): SelectorGroups {
		return this.#protocol.selectors();
	}

	respondsTo(selector: string): boolean {
		return this.#protocol.respondsTo(selector);
	}

	help(selector: string): string {
		return this.#protocol.lookup(selector).help(this.#scene.path);
	}

	printString(): string {
		return this.#receiver.printString();
	}
}
