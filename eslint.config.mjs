import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Only this project's own source is linted. Everything below is either build output,
    // a local scratch checkout, or material this repository does not author.
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "packages/*/dist/**",
      "docs/**",
      ".worktrees/**",
      ".crawlio/**",
      "crawlio-extension-*/**",
      "store-screenshots/**",
      "assets/**",
      "src/mcp-server/tool-embeddings.json",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // This codebase talks to CDP and the MCP wire, where payload shapes are genuinely
      // dynamic. Unknown-then-narrow is used where it pays; forcing it everywhere would add
      // casts without adding safety.
      "@typescript-eslint/no-explicit-any": "off",
      // Underscore marks a binding that must exist but is deliberately unused — an earlier
      // callback parameter, a destructured slot. For a caught error the codebase drops the
      // binding entirely (`catch { /* reason */ }`), which is also the only form both
      // linters accept: oxlint rejects `catch (_e)`.
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
      // An empty catch must be deliberate and say so; `catch { /* reason */ }` passes.
      "no-empty": ["error", { allowEmptyCatch: false }],
      // A timer handle declared before the listener that clears it, then assigned after, is
      // read-before-assign by design — the closure captures the binding, not the value.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // Worth seeing, not worth blocking a release over — these are readability, not bugs.
      "no-nested-ternary": "warn",
      // Attaching `cause` when rethrowing is good practice and worth doing over time, but it
      // is a change in what the code says, not a defect being fixed.
      "preserve-caught-error": "warn",
      // Fires on defensive initializers (`let x = ""` before a try that always assigns or
      // returns). Reviewed: every current instance is intentional, none is a bug.
      "no-useless-assignment": "warn",
      // Redaction strips ANSI sequences and selector validation rejects control characters,
      // so matching them in a regex is the point rather than a mistake.
      "no-control-regex": "off",
    },
  },
  {
    // The extension bundle is built by tsup as an IIFE and cannot import ambient types; the
    // triple-slash reference is how __DEV__ is declared for it.
    files: ["src/extension/**/*.ts"],
    rules: { "@typescript-eslint/triple-slash-reference": "off" },
  },
  {
    // Extension code runs in a service worker with the chrome.* APIs available.
    files: ["src/extension/**/*.ts"],
    languageOptions: {
      globals: { ...globals.webextensions, __DEV__: "readonly" },
    },
  },
  {
    // Every debugger attach must go through attachDebugger(), which records the tab in
    // attachedTabs and arms the idle-release alarm. A direct chrome.debugger.attach leaves a
    // tab attached but untracked: the banner stays up, the idle check never sees it, and
    // teardown misses it. That has already happened once.
    files: ["src/extension/background.ts"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector:
          "CallExpression[callee.object.object.name='chrome'][callee.object.property.name='debugger'][callee.property.name='attach']",
        message:
          "Attach through attachDebugger() so the tab is tracked and the idle-release alarm is armed. The two legitimate exceptions disable this rule inline and say why.",
      }],
    },
  },
  {
    // Injected page programs must stay self-contained and ES5-safe: they are stringified
    // into the page, where `var` hoisting is deliberate and modern syntax is a hazard.
    files: ["src/extension/injected/**/*.ts", "src/mcp-server/extraction-js.ts", "src/mcp-server/selector-kernel.ts"],
    rules: {
      "no-var": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
  {
    // Test fixtures build deliberately malformed input.
    files: ["tests/**"],
    rules: {
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
  {
    files: ["**/*.mjs", "**/*.cjs", "scripts/**"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
