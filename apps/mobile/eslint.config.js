// Flat ESLint config (ESLint 9) — mirrors apps/web, with Expo's RN-aware rules on top.
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  { ignores: ["dist/*", ".expo/*", "ios/*", "android/*"] },
]);
