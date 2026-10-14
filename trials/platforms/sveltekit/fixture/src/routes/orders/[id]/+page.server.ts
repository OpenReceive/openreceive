import { error } from '@sveltejs/kit';
import { findOrder } from '#lib/server/shop.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, cookies }) => {
	const userId = cookies.get('widget_user');
	const order = userId ? await findOrder(params.id, userId) : undefined;
	if (!order) error(404, 'That order is not yours.');
	return { order };
};
