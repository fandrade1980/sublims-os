import parser from "@typescript-eslint/parser";
import policy from "../../quality/policy.json" with { type: "json" };

const max = policy?.complexity?.maxCyclomaticPerFunction;

if (!Number.isInteger(max) || max < 1) {
  throw new Error(
    "quality/policy.json: `complexity.maxCyclomaticPerFunction` ausente ou não é inteiro >= 1"
  );
}

const complexity = ["error", { max, variant: "classic" }];

const linterOptions = {
  noInlineConfig: true,
  reportUnusedDisableDirectives: "error"
};

const languageOptions = {
  parser,
  ecmaVersion: "latest",
  sourceType: "module"
};

export default [
  {
    files: [
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "**/*.ts",
      "**/*.mts",
      "**/*.cts"
    ],
    languageOptions,
    linterOptions,
    rules: {
      complexity
    }
  },
  {
    files: [
      "**/*.jsx",
      "**/*.tsx"
    ],
    languageOptions: {
      ...languageOptions,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    linterOptions,
    rules: {
      complexity
    }
  }
];
