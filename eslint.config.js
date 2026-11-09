const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const reactHooks = require("eslint-plugin-react-hooks");

module.exports = tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      ".expo/**",
      "dist/**",
      "web-build/**",
      "supabase/**",
      // Plain Node scripts, not app code.
      "scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Unused args are often there to document a callback's shape; allow the
      // conventional leading underscore to opt out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      // The codebase has no `any` today; keep it that way.
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // Metro, Babel and this file itself are loaded by Node as CommonJS, so
    // require() is the only import form available to them.
    files: ["**/*.config.js", "eslint.config.js"],
    languageOptions: {
      globals: {
        module: "writable",
        require: "readonly",
        __dirname: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: {
        module: "writable",
        require: "readonly",
        __dirname: "readonly",
      },
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}", "jest.setup.js"],
    // jest.mock factories are hoisted above the imports, so they can only
    // reach modules through require().
    rules: { "@typescript-eslint/no-require-imports": "off" },
    languageOptions: {
      globals: {
        jest: "readonly",
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
      },
    },
  }
);
