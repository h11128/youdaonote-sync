// Code Quality Standards — ESLint flat config template
// See: docs/code-quality-standards.md §7.3
//
// Usage: copy to project root, adjust imports as needed.

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  prettier,
  {
    rules: {
      "sonarjs/cognitive-complexity": ["warn", 15],
      "complexity": ["warn", 15],
      "max-depth": ["warn", 4],
      "max-params": ["warn", 4],
      "max-lines-per-function": ["warn", 50, { skipBlankLines: true, skipComments: true }],
      "max-nested-callbacks": ["warn", 3],
      "max-lines": ["warn", 300],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "max-lines-per-function": ["warn", 80],
      "max-lines": ["warn", 600],
    },
  }
);
