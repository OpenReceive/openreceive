import { error, redirect } from '@sveltejs/kit';
import { createOrder, createUser, findProduct, userExists } from '#lib/server/shop.ts';
import type { RequestHandler } from './$types';

// The Buy button on the home page posts here.
export const POST: RequestHandler = async ({ request, cookies }) => {
	const form = await request.formData();
	const product = await findProduct(form.get('product_id'));
	if (!product) error(404, 'That product is not in the catalog.');

	let userId = cookies.get('widget_user');
	if (!userId || !(await userExists(userId))) {
		userId = await createUser();
		// The shop is served over plain HTTP, so the cookie cannot be Secure.
		cookies.set('widget_user', userId, { path: '/', httpOnly: true, sameSite: 'lax', secure: false });
	}
	const id = await createOrder(userId, product);
	redirect(303, `/orders/${id}`);
};
