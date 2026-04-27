/**
 * Имена бинарей и команд. Меняешь здесь — меняется везде в коде, тестах, help-выводе,
 * шелл-completion-скриптах. `package.json#bin` НЕ покрыт — обновлять там вручную при ренейме.
 */
export const MAIN_BIN = 'new-mpu';
export const SHEET_BIN = 'sheet';

export const BINS = [MAIN_BIN, SHEET_BIN] as const;
export type BinName = (typeof BINS)[number];
