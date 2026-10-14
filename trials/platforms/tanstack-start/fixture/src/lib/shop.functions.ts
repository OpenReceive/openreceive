import { createServerFn } from '@tanstack/react-start'
import { findOwnOrder, listProducts } from './shop.server'

export const getProducts = createServerFn({ method: 'GET' }).handler(() => listProducts())

export const getOrder = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => (await findOwnOrder(Number(id))) ?? null)
