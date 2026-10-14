import js from "@eslint/js";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

// The same shape as app/eslint.config.mjs: the recommended rules, plain JavaScript, Node globals.
export default defineConfig([
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.node } },
  globalIgnores(["node_modules/**"]),
]);
