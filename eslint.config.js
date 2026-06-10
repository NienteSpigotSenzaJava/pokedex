import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  AbortSignal: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setTimeout: "readonly"
};

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/*.tsbuildinfo"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,ts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals
    }
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error"
    }
  }
);
