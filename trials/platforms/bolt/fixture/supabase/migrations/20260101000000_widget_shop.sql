/*
  # Widget Shop: products and orders

  1. Tables
    - `products`: the catalog, readable by everyone
    - `orders`: one product per order, owned by the signed-in user who placed it
  2. Security
    - RLS on both tables
    - Anyone can read products
    - Signed-in users can create their own orders and read them
*/
create table if not exists public.products (
  id bigint generated always as identity primary key,
  name text not null,
  price numeric(10, 2) not null,
  currency text not null default 'USD',
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id bigint not null references public.products (id),
  title text not null,
  total numeric(10, 2) not null,
  currency text not null default 'USD',
  status text not null default 'awaiting_payment',
  created_at timestamptz not null default now()
);

alter table public.products enable row level security;
alter table public.orders enable row level security;

create policy "Anyone can view products"
  on public.products for select
  to anon, authenticated
  using (true);

create policy "Users can view their own orders"
  on public.orders for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can create their own orders"
  on public.orders for insert
  to authenticated
  with check (auth.uid() = user_id);

insert into public.products (name, price, currency) values
  ('Widget', 7.00, 'USD'),
  ('Gadget', 12.50, 'USD'),
  ('Doohickey', 20.00, 'USD'),
  ('Gizmo', 35.00, 'USD'),
  ('Thingamajig', 50.00, 'USD');
