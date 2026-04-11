#!/usr/bin/env bash
# envault.sh — Triple-encrypt/decrypt .env files for safe git sync.
#
# Encryption chain: AES-256-CTR → ChaCha20 → Camellia-256-CTR
# Each layer uses PBKDF2 (100k iterations) with independent salt.
# Single password, three independent keys via different salts.
#
# Requirements: only openssl (ships with every Linux/macOS).
#
# Usage:
#   envault.sh encrypt <plaintext> <encrypted>
#   envault.sh decrypt <encrypted> <plaintext>
#   envault.sh changed <plaintext> <encrypted>   # exit 0 if needs re-encrypt
#   envault.sh ensure  <plaintext> <encrypted>    # interactive: decrypt if needed
#
# Password: MPU_ENV_PASS env var, or interactive prompt.
# Skip: MPU_ENV_SKIP=1 to skip all encrypt/decrypt operations silently.
# Auto-confirm: MPU_ENV_YES=1 to skip y/n prompts (for CI/scripts).

set -euo pipefail

ITER=100000

die() { echo "error: $*" >&2; exit 1; }

# Ask yes/no question. Returns 0 for yes, 1 for no.
ask_yn() {
    local prompt="$1" default="${2:-n}"
    # Auto-confirm mode.
    if [ "${MPU_ENV_YES:-}" = "1" ]; then
        return 0
    fi
    if [ ! -t 0 ]; then
        # Non-interactive: use default.
        [ "$default" = "y" ] && return 0 || return 1
    fi
    local yn
    if [ "$default" = "y" ]; then
        read -rp "$prompt [Y/n] " yn >&2
        case "$yn" in
            [Nn]*) return 1 ;;
            *) return 0 ;;
        esac
    else
        read -rp "$prompt [y/N] " yn >&2
        case "$yn" in
            [Yy]*) return 0 ;;
            *) return 1 ;;
        esac
    fi
}

get_password() {
    if [ -n "${MPU_ENV_PASS:-}" ]; then
        echo "$MPU_ENV_PASS"
        return
    fi
    if [ -t 0 ]; then
        read -rsp "Password: " pass >&2
        echo >&2
        echo "$pass"
    else
        die "no password: set MPU_ENV_PASS or run interactively"
    fi
}

encrypt_layer() {
    local cipher="$1" salt="$2" pass="$3"
    openssl enc -"$cipher" -salt -pbkdf2 -iter "$ITER" -pass "pass:${pass}${salt}" 2>/dev/null
}

decrypt_layer() {
    local cipher="$1" salt="$2" pass="$3"
    openssl enc -d -"$cipher" -salt -pbkdf2 -iter "$ITER" -pass "pass:${pass}${salt}" 2>/dev/null
}

do_encrypt() {
    local src="$1" dst="$2" pass="$3"
    cat "$src" \
        | encrypt_layer aes-256-ctr      mpu-layer-1 "$pass" \
        | encrypt_layer chacha20         mpu-layer-2 "$pass" \
        | encrypt_layer camellia-256-ctr mpu-layer-3 "$pass" \
        > "$dst"
}

do_decrypt() {
    local src="$1" dst="$2" pass="$3"
    cat "$src" \
        | decrypt_layer camellia-256-ctr mpu-layer-3 "$pass" \
        | decrypt_layer chacha20         mpu-layer-2 "$pass" \
        | decrypt_layer aes-256-ctr      mpu-layer-1 "$pass" \
        > "$dst"
    chmod 600 "$dst"
}

cmd_encrypt() {
    local src="$1" dst="$2"
    [ -f "$src" ] || die "source file not found: $src"

    if [ "${MPU_ENV_SKIP:-}" = "1" ]; then
        echo "skip encrypt (MPU_ENV_SKIP=1)"
        return
    fi

    if ! ask_yn "Encrypt $src → $dst?"; then
        echo "skipped"
        return
    fi

    local pass
    pass=$(get_password)
    [ -n "$pass" ] || die "empty password"
    do_encrypt "$src" "$dst" "$pass"
    echo "encrypted: $src → $dst"
}

cmd_decrypt() {
    local src="$1" dst="$2"
    [ -f "$src" ] || die "encrypted file not found: $src"

    if [ "${MPU_ENV_SKIP:-}" = "1" ]; then
        echo "skip decrypt (MPU_ENV_SKIP=1)"
        return
    fi

    if ! ask_yn "Decrypt $src → $dst?"; then
        echo "skipped"
        return
    fi

    local pass
    pass=$(get_password)
    [ -n "$pass" ] || die "empty password"
    do_decrypt "$src" "$dst" "$pass"
    echo "decrypted: $src → $dst"
}

# ensure: if plaintext missing and encrypted exists, offer to decrypt.
cmd_ensure() {
    local plain="$1" enc="$2"

    # Already have plaintext — nothing to do.
    [ -f "$plain" ] && return 0

    # No encrypted file either — nothing we can do.
    [ -f "$enc" ] || return 0

    if [ "${MPU_ENV_SKIP:-}" = "1" ]; then
        echo "skip decrypt (MPU_ENV_SKIP=1)"
        return 0
    fi

    echo "$plain not found, $enc available."
    if ! ask_yn "Decrypt $enc → $plain?"; then
        echo "skipped — continuing without $plain"
        return 0
    fi

    local pass
    pass=$(get_password)
    [ -n "$pass" ] || die "empty password"
    do_decrypt "$enc" "$plain" "$pass"
    echo "decrypted: $enc → $plain"
}

cmd_changed() {
    local src="$1" enc="$2"
    [ -f "$enc" ] || exit 0
    [ -f "$src" ] || exit 1

    local pass
    pass=$(get_password)
    [ -n "$pass" ] || die "empty password"

    local tmp
    tmp=$(mktemp)
    trap "rm -f $tmp" EXIT

    if do_decrypt "$enc" "$tmp" "$pass" 2>/dev/null; then
        if diff -q "$src" "$tmp" >/dev/null 2>&1; then
            exit 1  # not changed
        else
            exit 0  # changed
        fi
    else
        exit 0  # decrypt failed → treat as changed
    fi
}

# sync: interactive re-encrypt if changed.
cmd_sync() {
    local src="$1" enc="$2"
    [ -f "$src" ] || die "source file not found: $src"

    if [ "${MPU_ENV_SKIP:-}" = "1" ]; then
        echo "skip sync (MPU_ENV_SKIP=1)"
        return
    fi

    local pass
    pass=$(get_password)
    [ -n "$pass" ] || die "empty password"

    if [ ! -f "$enc" ]; then
        if ask_yn "$enc doesn't exist. Encrypt $src?"; then
            do_encrypt "$src" "$enc" "$pass"
            echo "encrypted: $src → $enc"
        else
            echo "skipped"
        fi
        return
    fi

    # Compare
    local tmp
    tmp=$(mktemp)
    trap "rm -f $tmp" EXIT

    if do_decrypt "$enc" "$tmp" "$pass" 2>/dev/null && diff -q "$src" "$tmp" >/dev/null 2>&1; then
        echo "$src unchanged — skip encrypt"
    else
        do_encrypt "$src" "$enc" "$pass"
        echo "encrypted: $src → $enc"
    fi
}

case "${1:-}" in
    encrypt) cmd_encrypt "${2:?usage: envault.sh encrypt <src> <dst>}" "${3:?}" ;;
    decrypt) cmd_decrypt "${2:?usage: envault.sh decrypt <src> <dst>}" "${3:?}" ;;
    ensure)  cmd_ensure  "${2:?usage: envault.sh ensure <plain> <enc>}" "${3:?}" ;;
    changed) cmd_changed "${2:?usage: envault.sh changed <src> <enc>}" "${3:?}" ;;
    sync)    cmd_sync    "${2:?usage: envault.sh sync <src> <enc>}" "${3:?}" ;;
    *) die "usage: envault.sh {encrypt|decrypt|ensure|sync|changed} <file1> <file2>" ;;
esac
