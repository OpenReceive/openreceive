import type { ServerInit } from '@sveltejs/kit/hooks';
import { createTables } from '#lib/server/db.ts';

// Runs once when the server starts, before it answers a request.
export const init: ServerInit = async () => {
	await createTables();
};
