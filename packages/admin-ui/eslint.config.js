// Extend root eslint config with React Hooks rules for the admin UI.
// Note: admin-ui runs eslint with cwd=packages/admin-ui (eslint src/), so we must match local paths.
import baseConfig from '../../eslint.config.js';
import reactHooks from 'eslint-plugin-react-hooks';

const base = Array.isArray(baseConfig) ? baseConfig : [baseConfig];

export default [
	...base,
	{
		files: ['src/**/*.{ts,tsx}'],
		plugins: {
			'react-hooks': reactHooks,
		},
		rules: {
			...reactHooks.configs.recommended.rules,
		},
	},
];
