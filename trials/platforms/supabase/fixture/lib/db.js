import pg from "pg";

// Supabase's transaction pooler, verified against Supabase's certificate
// authority, as https://openreceive.org/guides/supabase shows. The host sets
// DATABASE_URL (the pooler URL, port 6543) and SUPABASE_CA_CERT (the text of
// prod-ca-2021.crt) in the server's environment. The URL's sslmode would win
// over the ssl option, so it is removed.
const url = new URL(process.env.DATABASE_URL);
url.searchParams.delete("sslmode");

export const pool = new pg.Pool({
  connectionString: url.toString(),
  ssl: { ca: process.env.SUPABASE_CA_CERT },
  max: 5,
});
