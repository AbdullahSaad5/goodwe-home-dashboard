import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['data/**', 'dist/**', 'node_modules/**', 'web/public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Data-fetching effects intentionally update state after async requests.
      'react-hooks/set-state-in-effect': 'off',
      // Components and their small, tested helpers are colocated in this application.
      'react-refresh/only-export-components': 'off',
    },
  },
);
