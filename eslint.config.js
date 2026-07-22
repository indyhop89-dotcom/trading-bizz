import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Underscore-prefixed names are this codebase's established convention
      // for "intentionally unused" — UI-only line fields that must not reach
      // a DB payload (_id, _cost_rate, _hsn_*) and destructure-to-exclude
      // patterns like `({ _label, ...rest }) => rest`. Recognize it instead
      // of hand-suppressing each one.
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      // react-hooks/set-state-in-effect is part of the React Compiler safety
      // heuristics bundled into this plugin's "recommended" flat config —
      // this project doesn't use the Compiler (no babel-plugin-react-compiler
      // or equivalent Vite plugin is configured), so the rule is checking for
      // a hazard that can't occur here. Every one of its ~50 findings in this
      // codebase is the same accepted, correct-in-plain-React idiom used on
      // literally every data-driven page:
      //   const load = useCallback(async () => { setLoading(true); ...load
      //   from Supabase...; setX(data) }, [...])
      //   useEffect(() => { load() }, [load])
      // This is the standard "fetch on mount, refetch when a filter changes"
      // pattern — load()'s first synchronous statement is what trips the
      // rule, but there is nothing unsafe about it without the Compiler.
      // Rewriting every occurrence (deferring the call via a microtask, etc.)
      // would be churn across most of the app for a rule that doesn't apply
      // to this project's build. Revisit if React Compiler is ever adopted.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // react-refresh/only-export-components is a Fast Refresh DX heuristic
    // (a file mixing component + non-component exports loses hot-reload and
    // falls back to a full page reload — never a correctness or build
    // issue), not a hint that these exports should move. Each of these four
    // is a foundational shared module whose non-component exports are used
    // across many pages and belong right next to what defines them:
    //   - UI/index.jsx:    the design-token constants (C, RAW) for a UI kit
    //                      that's inherently components + tokens together.
    //   - LineItemsEditor: computeLine/computeTotals/ProductPicker are the
    //                      shared line-item math + picker every PI/PO/
    //                      Invoice form imports alongside the editor itself.
    //   - useAuth.jsx:     the standard AuthProvider component + useAuth()
    //                      hook pairing — splitting a context's provider
    //                      from its consumer hook is not the norm.
    //   - Sidebar.jsx:     NAV (used by Layout.jsx for the command palette)
    //                      belongs with the nav definitions that build it.
    files: [
      'src/components/UI/index.jsx',
      'src/components/LineItemsEditor.jsx',
      'src/hooks/useAuth.jsx',
      'src/components/Layout/Sidebar.jsx',
    ],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    // Test files run under Vitest's Node/jsdom environment, where installing
    // a mock (global.Blob, global.fetch, global.URL, ...) goes through
    // Node's `global`, not the browser's `window` — globals.browser alone
    // doesn't know about it.
    files: ['src/**/__tests__/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
])
