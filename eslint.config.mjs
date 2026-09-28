import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/next-env.d.ts", "**/dist/**", "legacy/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // CLAUDE.md, правило 1: в модулях ядра нет магических чисел.
    // Разрешены 0, 1, 12, 365 и индексы массивов; всё остальное — параметры по ID из data/*.yaml.
    files: ["packages/engine/src/modules/**/*.ts"],
    rules: {
      "no-magic-numbers": [
        "error",
        { ignore: [0, 1, 12, 365], ignoreArrayIndexes: true, enforceConst: true, detectObjects: true },
      ],
    },
  },
);
