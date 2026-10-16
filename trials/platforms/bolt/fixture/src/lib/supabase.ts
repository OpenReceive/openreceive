import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface Product {
  id: number;
  name: string;
  price: string;
  currency: string;
}

export interface Order {
  id: string;
  user_id: string;
  product_id: number;
  title: string;
  total: string;
  currency: string;
  status: 'awaiting_payment' | 'paid';
  created_at: string;
}
