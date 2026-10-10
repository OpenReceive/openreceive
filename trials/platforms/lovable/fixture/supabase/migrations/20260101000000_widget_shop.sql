-- The Widget Shop's catalog and orders. The catalog is public; orders are
-- read and written only by the server, with the service role key.
create table public.products (
  id bigint generated always as identity primary key,
  name text not null,
  price text not null,
  currency text not null default 'USD'
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references public.products (id),
  title text not null,
  total text not null,
  currency text not null,
  status text not null default 'awaiting_payment',
  created_at timestamptz not null default now()
);

alter table public.products enable row level security;
alter table public.orders enable row level security;

create policy "Anyone can read the catalog" on public.products for select using (true);

insert into public.products (name, price, currency) values
  ('Widget', '7.00', 'USD'),
  ('Gadget', '12.50', 'USD'),
  ('Doohickey', '20.00', 'USD'),
  ('Gizmo', '35.00', 'USD'),
  ('Thingamajig', '50.00', 'USD');
