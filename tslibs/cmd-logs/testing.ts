/**
 * Фейки для тестов потребителя (`@mpu/cmd-logs/testing`): Loki на петле
 * с заданным ответом и кэш-БД с хостами — io, которой хватает строке с
 * `logs` без сети наружу.
 */

export { lokiBody, withFakeLoki } from "./src/testloki.ts";
