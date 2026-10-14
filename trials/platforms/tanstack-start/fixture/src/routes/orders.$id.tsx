import { createFileRoute, notFound } from '@tanstack/react-router'
import { getOrder } from '#/lib/shop.functions'

export const Route = createFileRoute('/orders/$id')({
  loader: async ({ params }) => {
    const order = await getOrder({ data: params.id })
    if (!order) throw notFound()
    return order
  },
  component: OrderPage,
  notFoundComponent: () => (
    <main>
      <h1>Not found</h1>
      <p>That order is not yours.</p>
    </main>
  ),
})

function OrderPage() {
  const order = Route.useLoaderData()
  return (
    <main>
      <h1>Order {order.id}</h1>
      <p>
        {order.product_name} — ${order.amount} {order.currency}
      </p>
      <p>
        {order.status === 'paid'
          ? 'Paid.'
          : 'Awaiting payment. Online payments are not set up yet.'}
      </p>
    </main>
  )
}
