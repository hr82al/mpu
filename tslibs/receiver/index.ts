/**
 * `@mpu/receiver` — протокол получателя: описание `about` рядом с методами,
 * конверт с проверкой ключей, правилами, журналом и отражением, файл
 * интерфейса. Спека — `ts/docs/specs/platform/tslibs-receiver.md`.
 */

export type {
	About,
	Deprecated,
	Described,
	Effect,
	Example,
	MethodAbout,
	Methods,
	ReceiverClass,
	Selectors,
} from "./src/about.ts";
export { described } from "./src/about.ts";
export type {
	Answer,
	Enveloped,
	Keys,
	Listener,
	RefusalData,
} from "./src/answer.ts";
export { breaches } from "./src/compat.ts";
export type {
	Clock,
	Context,
	Journal,
	JournalEntry,
	Outcome,
} from "./src/context.ts";
export type {
	ArgsSchema,
	Description,
	ExampleDescription,
	MethodDescription,
	ReceiverDescription,
	SelectorGroups,
} from "./src/description.ts";
export { envelope } from "./src/envelope.ts";
export { DuplicateClassName } from "./src/graph.ts";
export type { InterfaceFile, Root } from "./src/interface.ts";
export {
	interfaceJson,
	interfaceMarkdown,
	interfaceOf,
} from "./src/interface.ts";
export { JournalFailure } from "./src/method.ts";
export type {
	Admission,
	Asker,
	Followed,
	Reply,
	Rule,
	RuleBook,
} from "./src/rules.ts";
export {
	agreed,
	allow,
	ask,
	deny,
	inherited,
	refused,
} from "./src/rules.ts";
export type { InterfaceTarget } from "./src/write.ts";
export { InterfaceBreach, writeInterface } from "./src/write.ts";
