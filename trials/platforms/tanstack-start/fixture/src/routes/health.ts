import { createFileRoute } from '@tanstack/react-router'
import { db } from '#/lib/db.server'

export const Route = createFileRoute('/health')({
  server: {
    handlers: {
      // Healthy once the database answers and the shop's tables exist.
      GET: async () => {
        await db()
        return new Response('ok\n', { headers: { 'content-type': 'text/plain' } })
      },
    },
  },
})
