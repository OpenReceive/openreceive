import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { supabase, type Product } from '../lib/supabase';

export default function Home({ session }: { session: Session | null }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    supabase
      .from('products')
      .select('*')
      .order('id')
      .then(({ data, error: loadError }) => {
        if (loadError) setError(loadError.message);
        else setProducts(data ?? []);
      });
  }, []);

  async function buy(product: Product) {
    if (!session) {
      navigate('/login');
      return;
    }
    const { data, error: insertError } = await supabase
      .from('orders')
      .insert({
        user_id: session.user.id,
        product_id: product.id,
        title: product.name,
        total: product.price,
        currency: product.currency,
      })
      .select('id')
      .single();
    if (insertError) {
      setError(insertError.message);
      return;
    }
    navigate(`/orders/${data.id}`);
  }

  return (
    <section>
      <h1>Widgets</h1>
      {error && <p className="error">{error}</p>}
      <ul className="products">
        {products.map((product) => (
          <li key={product.id} data-product-id={product.id}>
            <h2>{product.name}</h2>
            <p>${product.price}</p>
            <button type="button" onClick={() => buy(product)}>Buy</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
