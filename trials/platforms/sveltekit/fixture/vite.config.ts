import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			csrf: {
				// The shop is served over plain HTTP on whatever port Compose
				// publishes, with no proxy in front. adapter-node takes the
				// request's origin to be https://<host> unless a proxy says
				// otherwise, so the default Origin check refused every order form.
				trustedOrigins: ['*']
			}
		})
	]
});
