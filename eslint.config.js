import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/release/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // 未使用的变量：允许 _ 前缀显式表达「我知道它没用」
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // any 会让 strict 模式形同虚设（docs/design/07 §5）
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // 构建脚本是 JS，不走类型规则
    // 构建脚本与打包产物的冒烟测试：它们的输出**就是**接口（CI 读它），
    // console 不是调试残留
    files: ['scripts/**/*.mjs', 'apps/*/scripts/**/*.mjs', 'e2e/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: { 'no-console': 'off' },
  },
)
