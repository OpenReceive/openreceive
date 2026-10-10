-- PostgREST logs in as authenticator, as on Supabase, and switches to the role
-- in each request's token.
alter role authenticator with password 'shop';
