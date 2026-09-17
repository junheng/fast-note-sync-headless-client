// Daemon retry policy. Keeping it in one place makes the bound explicit and
// testable; the values are part of the operating contract for `daemon`.
export const MAX_DAEMON_FAILURES = 8;
export const MAX_RETRY_DELAY_MS = 60000;
export const FATAL_DAEMON_CODES = ["state-identity-mismatch", "state-corrupt", "state-format-unsupported"];

export const retryDelayMs = (failures, interval) => Math.min(MAX_RETRY_DELAY_MS, interval * 2 ** failures);
export const retryable = code => !FATAL_DAEMON_CODES.includes(code);
