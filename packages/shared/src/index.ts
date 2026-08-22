/**
 * `src/shared` — the pure core: shapes, vocabularies and rules that BOTH a browser client and a
 * (future) native client must agree on, with zero imports outside this folder.
 *
 * The rule that makes this folder liftable: **nothing here may import from `src/lib`, `src/app`,
 * or any npm package.** Dependencies point inward only; it is enforced by a `no-restricted-imports`
 * rule in `eslint.config.js`. When the repo becomes a workspace this folder moves verbatim to
 * `packages/shared/src`. See docs/2026-08-09-shareable-core-refactor.md and
 * docs/2026-08-09-expo-repo-structure-migration.md.
 *
 * This barrel exists for external consumers. Inside `src/`, import the specific module
 * (`../shared/word-types`) rather than the barrel, so a client bundle pulls only what it names.
 */
export * from "./theme";
export * from "./tutor";
export * from "./tutor-transport";
export * from "./tutor-pause";
export * from "./word-types";
export * from "./word-key";
export * from "./lesson-types";
export * from "./items-query";
export * from "./item-list";
export * from "./sync-ops";
export * from "./mirror-store";
export * from "./api";
