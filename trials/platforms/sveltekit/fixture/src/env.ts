import { building } from '$app/env';
import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	DATABASE_URL: {
		description: 'The Postgres connection string.',
		// `vite build` runs the app to analyse it, without a database.
		schema: (value: string | undefined) => {
			if (value) return value;
			if (building) return '';
			throw new Error('is not set');
		}
	}
});
