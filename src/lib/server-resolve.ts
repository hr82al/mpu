const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function looksLikeIp(s: string): boolean {
  return IPV4_RE.test(s);
}

export type EnvGetter = (key: string) => string | undefined;

/**
 * Резолвит server-имя (`sl-1` / `sl_1`) в IP через env.
 * IP возвращается как есть.
 *
 * Порядок проб env-ключей:
 *   1. имя как есть (`sl-1`)
 *   2. `-` → `_`             (`sl_1`)
 *   3. UPPERCASE              (`SL_1`)
 */
export function resolveServerIp(name: string, env: EnvGetter): string {
  if (!name) throw new Error('server name is empty');
  if (looksLikeIp(name)) return name;

  const candidates = [name, name.replaceAll('-', '_'), name.replaceAll('-', '_').toUpperCase()];
  const seen = new Set<string>();
  for (const k of candidates) {
    if (seen.has(k)) continue;
    seen.add(k);
    const v = env(k);
    if (v) return v;
  }

  const tried = [...seen].join(', ');
  throw new Error(
    `host for server "${name}" not found in env (tried: ${tried}).\n` +
      `Add to ~/.config/mpu/.env:\n  ${name.replaceAll('-', '_')}=<host address>`,
  );
}
