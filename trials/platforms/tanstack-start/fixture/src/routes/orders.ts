import { createFileRoute } from '@tanstack/react-router'
import { createOrder, createUser, currentUserId, findProduct } from '#/lib/shop.server'

// The Buy form posts here. The order gets the product's price from the
// catalog, and the buyer lands on the order's page.
export const Route = createFileRoute('/orders')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData()
        const product = await findProduct(Number(form.get('product_id')))
        if (!product) {
          return new Response('That product is not in the catalog.\n', { status: 404 })
        }
        const userId = (await currentUserId()) ?? (await createUser())
        const id = await createOrder(userId, product)
        // 303: the browser follows it with a GET.
        return new Response(null, { status: 303, headers: { location: `/orders/${id}` } })
      },
    },
  },
})
