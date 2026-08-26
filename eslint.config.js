import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const generatedAndExternal = [
  "attached_assets/**",
  "dist/**",
  "electron/app/**",
  "electron/release/**",
  "node_modules/**",
  "src-tauri/gen/**",
  "src-tauri/target/**",
  "scripts/fixtures/**",
  "client/src/lib/nextera/mechDrawings.ts",
];

export default tseslint.config(
  {
    ignores: generatedAndExternal,
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["client/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "off",
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: ["server/**/*.ts", "scripts/**/*.{js,mjs,ts}", "*.config.{js,mjs,ts}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-console": "off",
      "no-debugger": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-regex-spaces": "off",
      "no-throw-literal": "error",
      "no-undef": "off",
      "no-unreachable": "error",
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "off",
      "no-with": "error",
      "prefer-const": "off",
    },
  },
  {
    files: ["scripts/**/*.{js,mjs,ts}"],
    rules: {
      "no-control-regex": "off",
      "no-loss-of-precision": "off",
      "no-new-func": "off",
    },
  },
);