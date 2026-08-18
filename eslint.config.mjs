import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // *.mjs has no type information, and linting this file crashes the type-aware rules
  { ignores: ["node_modules/**", "main.js", "*.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json", sourceType: "module" },
    },
  },
  {
    // node:test's describe/it return promises that are not meant to be awaited,
    // and test files are not plugin code the community scanner cares about
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // The test file is never bundled into main.js, so it never reaches mobile
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
]);
