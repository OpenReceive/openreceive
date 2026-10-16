import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(event: FormEvent<HTMLFormElement>, mode: 'signup' | 'login') {
    event.preventDefault();
    const { error: authError } =
      mode === 'signup'
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
    if (authError) setError(authError.message);
    else navigate('/');
  }

  return (
    <section>
      <h1>Sign in</h1>
      {error && <p className="error">{error}</p>}
      <form onSubmit={(event) => submit(event, 'login')}>
        <label>
          Email <input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password{' '}
          <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        </label>
        <button type="submit">Log in</button>
        <button type="button" onClick={(event) => submit(event as unknown as FormEvent<HTMLFormElement>, 'signup')}>
          Create account
        </button>
      </form>
    </section>
  );
}
