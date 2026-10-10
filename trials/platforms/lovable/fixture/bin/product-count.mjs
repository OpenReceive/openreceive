const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/products`);
url.searchParams.set("select", "id");
const response = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY } });
console.log(response.ok ? (await response.json()).length : 0);
