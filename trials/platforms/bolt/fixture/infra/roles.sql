-- PostgREST logs in as authenticator and Supabase Auth as supabase_auth_admin,
-- as on Supabase.
alter role authenticator with password 'shop';
alter role supabase_auth_admin with password 'shop';
