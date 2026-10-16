import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase, type Order } from '../lib/supabase';

export default function OrderPage() {
  const { id } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('orders')
      .select('*')
      .eq('id', id)
      .maybeSingle()
      .then(({ data, error: loadError }) => {
        if (loadError) setError(loadError.message);
        else if (!data) setError('Order not found.');
        else setOrder(data);
      });
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!order) return <p>Loading…</p>;

  return (
    <section>
      <h1>Order {order.id.slice(0, 8)}</h1>
      <p>
        {order.title}: ${order.total} {order.currency}
      </p>
      <p className="status">Status: {order.status}</p>
      {order.status === 'awaiting_payment' && <p className="payment">Payment is coming soon.</p>}
    </section>
  );
}
