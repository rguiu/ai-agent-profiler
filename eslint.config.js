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
      "benchmarks/runs/",
      "benchmarks/artifacts/",
      "benchmarks/reference/",
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
        confirm: "readonly",
        alert: "readonly",
        TextDecoder: "readonly",
        Uint8Array: "readonly",
        URLSearchParams: "readonly",
        console: "readonly",
        DecompressionStream: "readonly",
        Response: "readonly",
        requestAnimationFrame: "readonly",
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
