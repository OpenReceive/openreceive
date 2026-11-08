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
			paths: {
				// The shop's public address, which the Origin check on form posts
				// compares with. Without it adapter-node takes it to be
				// https://<host>, and this shop is served over plain HTTP with no
				// proxy in front. Built in at `vite build`, from compose.yml's
				// ORIGIN build argument.
				origin: process.env.ORIGIN || undefined
			}
		})
	]
});
