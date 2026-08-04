/**
 * Shell-completion (`platform/registry.md`): печать и установка
 * скрипта дополнения. Сам скрипт — тонкая обвязка: он зовёт бинарь со
 * служебной env-переменной, а варианты собирает уже точка входа.
 *
 * Shell определяется по ближайшему известному shell в дереве
 * процессов-предков; переменная `SHELL` не участвует намеренно — при
 * bash-родителе и `SHELL=/bin/zsh` нужен bash-скрипт.
 */

/** Shell, для которого умеем печатать скрипт. */
export type Shell = "bash" | "zsh";

/** Служебная env-переменная режима дополнения. */
export const COMPLETE_ENV = "_MPU_COMPLETE";

/** Значения `_MPU_COMPLETE` по shell. */
const COMPLETE_MODE: Readonly<Record<Shell, string>> = {
  bash: "complete_bash",
  zsh: "complete_zsh",
};

/** rc-файл shell, куда дописывается скрипт. */
const RC_FILE: Readonly<Record<Shell, string>> = {
  bash: ".bashrc",
  zsh: ".zshrc",
};

/**
 * Скрипт дополнения для shell. Текст воспроизводит эталон
 * (`fixtures/platform/registry/completion-*.txt`): он попадает в
 * rc-файл пользователя, и расхождение с эталоном означало бы, что
 * установленное дополнение работает иначе, чем описано.
 */
export function completionScript(shell: Shell): string {
  return shell === "bash" ? BASH_SCRIPT : ZSH_SCRIPT;
}

const BASH_SCRIPT = `_mpu_completion() {
    local IFS=$'
'
    COMPREPLY=( $( env COMP_WORDS="\${COMP_WORDS[*]}" \\
                   COMP_CWORD=$COMP_CWORD \\
                   ${COMPLETE_ENV}=${COMPLETE_MODE.bash} $1 ) )
    return 0
}

complete -o default -F _mpu_completion mpu
`;

const ZSH_SCRIPT = `#compdef mpu

_mpu_completion() {
  eval $(env _TYPER_COMPLETE_ARGS="\${words[1,$CURRENT]}" \
${COMPLETE_ENV}=${COMPLETE_MODE.zsh} mpu)
}

compdef _mpu_completion mpu
`;

/** Куда установка допишет скрипт: rc-файл в домашнем каталоге. */
export function completionRcPath(
  shell: Shell,
  home: string | undefined,
): string | undefined {
  if (home === undefined || home === "") return undefined;
  return `${home}/${RC_FILE[shell]}`;
}

/**
 * Варианты дополнения для незавершённого слова. Список собирается из
 * тех же имён, что и справка: рассинхрон между дополнением и справкой
 * невозможен по построению (инвариант спеки про единый реестр).
 */
export function completionCandidates(
  names: readonly string[],
  word: string,
): readonly string[] {
  return names.filter((name) => name.startsWith(word));
}

/**
 * Ответ режима дополнения. bash читает по строке на вариант, zsh
 * исполняет вывод как код, поэтому там варианты передаются `compadd`.
 */
export function completionReply(
  shell: Shell,
  candidates: readonly string[],
): string {
  if (candidates.length === 0) return "";
  return shell === "bash"
    ? `${candidates.join("\n")}\n`
    : `compadd -- ${candidates.join(" ")}\n`;
}

/** Режим дополнения по значению `_MPU_COMPLETE`; чужое значение — нет. */
export function completionMode(value: string | undefined): Shell | undefined {
  if (value === COMPLETE_MODE.bash) return "bash";
  if (value === COMPLETE_MODE.zsh) return "zsh";
  return undefined;
}
