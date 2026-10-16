// edge-runtime's main service: each request to /<name>/... goes to a user
// worker for supabase/functions/<name>, under Supabase's hosted limits (2 s
// of CPU, 1 s soft, 256 MB, 150 s of wall clock), with the environment
// Supabase gives a deployed function, as `supabase functions serve` does.
Deno.serve(async (request) => {
  const name = new URL(request.url).pathname.split("/")[1];
  if (!name) return new Response("ok\n");
  const servicePath = `/srv/functions/${name}`;
  try {
    await Deno.stat(servicePath);
  } catch {
    return Response.json({ code: "NOT_FOUND", message: "Requested function was not found" }, { status: 404 });
  }
  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 256,
      workerTimeoutMs: 150_000,
      noModuleCache: false,
      envVars: Object.entries(Deno.env.toObject()),
      forceCreate: false,
      cpuTimeSoftLimitMs: 1000,
      cpuTimeHardLimitMs: 2000,
    });
    return await worker.fetch(request);
  } catch (error) {
    console.error(`function ${name}:`, error);
    return Response.json({ code: "BOOT_ERROR", message: String(error) }, { status: 503 });
  }
});
