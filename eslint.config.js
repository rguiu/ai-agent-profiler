import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "notes/",
      "coverage/",
      "benchmarks/fixtures/",
      ".opencode/",
      ".claude/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["web/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        location: "readonly",
        fetch: "readonly",
        atob: "readonly",
        TextDecoder: "readonly",
        Uint8Array: "readonly",
        console: "readonly",
      },
    },
  },
  {
    files: ["benchmarks/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
  },
  prettier,
);
