// edge-runtime's main service: each request goes to a user worker for
// functions/<name>, under Supabase's hosted limits (2 s of CPU, 1 s soft,
// 256 MB, 150 s of wall clock), as `supabase functions serve` creates them.
Deno.serve(async (request) => {
  const name = new URL(request.url).pathname.split("/")[1];
  if (!name) return new Response("ok\n");
  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: `/srv/functions/${name}`,
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
    return Response.json({ worker_error: String(error) }, { status: 546 });
  }
});
