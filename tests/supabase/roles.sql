-- PostgREST logs in as authenticator, as on Supabase, and switches to the role
-- in the request's token.
alter role authenticator with password 'openreceive';
