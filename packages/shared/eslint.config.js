// Flat ESLint config (ESLint 9) for @tutor/shared — the pure core.
//
// This package holds the shapes and rules that the web client and a future native client must both
// agree on. It has to stay liftable, which means dependencies point INWARD ONLY: nothing here may
// reach into an app, and nothing here may import an npm package (its `dependencies` are empty by
// design). Enforced rather than remembered.
//
// There are now TWO boundaries here, and they are enforced the same way:
//   - the OUTER one (`OUTER`, below) — what the package as a whole may not reach for;
//   - the INNER one (`zone()`, below) — the order the domains sit in relative to each other.
// See packages/shared/docs/architecture.md, and docs/2026-08-22-shared-package-structure.md §5.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// ── the outer boundary: the package stays liftable ───────────────────────────────────────────
const OUTER = [
  {
    group: ["**/lib/*", "**/lib", "**/app/*", "**/app"],
    message:
      "@tutor/shared must not import from an app — it is the pure core and has to stay liftable. Extract the pure part into this package instead.",
  },
  {
    // Anything not starting with "." is a bare specifier, i.e. an npm package.
    regex: "^[^.]",
    message:
      "@tutor/shared has zero runtime dependencies. If you need a package here, the logic probably belongs on the server instead — see docs/2026-08-09-expo-repo-structure-migration.md §5.",
  },
];

/** Ban a sibling domain. Both spellings, because the depth of the importer is not fixed. */
const not = (domain, why) => ({
  group: [`../${domain}`, `../${domain}/*`, `**/${domain}`, `**/${domain}/*`],
  message: why,
});

const NOT_TESTING = not(
  "testing",
  "`src/testing/` holds test doubles. Nothing shipped may import it — `check.ts` sits outside `src/` precisely so it can.",
);
const NOT_API = not(
  "api",
  "`api.ts` is the TOP of the graph: it names every domain, so no domain may name it. A shape both need belongs in the domain, not on the wire module.",
);

// A zone REPLACES the rule it inherits rather than adding to it — flat config does not merge rule
// options — so every zone must restate OUTER. That is what this helper is for; hand-writing the
// zones would drop the npm ban for those files, silently.
const zone = (files, extra) => ({
  files,
  rules: {
    "no-restricted-imports": ["error", { patterns: [...OUTER, ...extra] }],
  },
});

export default tseslint.config(
  {
    ignores: ["**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Everything in the package, including the check harness at the root.
    files: ["**/*.ts"],
    rules: {
      // TS already checks undefined identifiers, and this code uses platform globals
      // (URLSearchParams, console). Let TS own that check.
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },

  // The boundary applies to `src/**` ONLY — that is the pure core. `check.ts` sits outside it
  // precisely so it can be a Node script (it imports `node:process`) and can reach `src/testing/`,
  // without punching a hole in the rules below. Same reason it has its own tsconfig.
  //
  // Zones are ordered general → specific, because the last matching one wins.
  zone(["src/**/*.ts"], [NOT_TESTING]),

  // The layering, stated as what each domain may NOT name. Read downward: `words` sits at the
  // bottom and `api.ts` at the top, and nothing may reach back up.
  zone(["src/theme.ts"], [NOT_TESTING, { regex: "^\\.", message: "`theme.ts` is inert data and imports nothing. Keep it that way — it is the one module with no dependencies at all." }]),
  zone(["src/words/**/*.ts"], [NOT_TESTING, NOT_API, not("tutor", "`words/` is the bottom of the graph — `tutor/` names it, not the other way round."), not("lessons", "`words/` is the bottom of the graph — `lessons/` names it, not the other way round."), not("offline", "`words/` is the bottom of the graph — `offline/` names it, not the other way round.")]),
  zone(["src/tutor/**/*.ts"], [NOT_TESTING, NOT_API, not("lessons", "`lessons/` names `tutor/`, so `tutor/` may not name it back."), not("offline", "`offline/` names `tutor/`, so `tutor/` may not name it back.")]),
  zone(["src/lessons/**/*.ts", "src/offline/**/*.ts"], [NOT_TESTING, NOT_API]),

  // `src/testing/` may name what it fakes; it is excluded from NOT_TESTING by having its own zone.
  zone(["src/testing/**/*.ts"], [NOT_API]),
);
