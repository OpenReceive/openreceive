export const dynamic = "force-dynamic";

export function GET() {
  return new Response("ok\n", { headers: { "content-type": "text/plain" } });
}
