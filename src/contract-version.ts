/**
 * Single source of truth for the control-protocol contract version.
 *
 * Consumed from TWO worlds, which previously each kept their own constant
 * (a contract bump that touched only one side would split source-mode and
 * bundled builds into mutually "incompatible" contracts → replace-war):
 *  - src/build-info.ts imports it as the source-mode fallback;
 *  - scripts/build-bundles.mjs extracts it from THIS file (regex on the
 *    line below) to inject as the bundle define.
 *
 * Bump rule: changing the control-protocol message schema incompatibly =
 * edit the single line below. A unit test locks the build-script extraction
 * against this export.
 */
export const CONTRACT_VERSION = 1;
