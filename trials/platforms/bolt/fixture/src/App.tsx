import { useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import Home from './pages/Home';
import Login from './pages/Login';
import OrderPage from './pages/Order';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <div className="shop">
      <header>
        <Link to="/" className="brand">Widget Shop</Link>
        {session ? (
          <span className="account">
            {session.user.email}{' '}
            <button type="button" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </span>
        ) : (
          <Link to="/login">Sign in</Link>
        )}
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home session={session} />} />
          <Route path="/login" element={<Login />} />
          <Route path="/orders/:id" element={<OrderPage />} />
        </Routes>
      </main>
    </div>
  );
}
