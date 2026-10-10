// The order's status column, read as the server reads it: Supabase's API
// with the service role key.
const id = process.argv[2] ?? "";
const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/orders`);
url.searchParams.set("id", `eq.${id}`);
url.searchParams.set("select", "status");
const response = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY } });
const rows = response.ok ? await response.json() : [];
console.log(rows[0]?.status ?? "");
