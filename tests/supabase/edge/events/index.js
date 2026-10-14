// Every runtime event but log lines, one JSON line each, so the test can see
// a worker that the runtime stopped for CPU time.
const events = new globalThis.EventManager();
console.log("event manager running");
for await (const data of events) {
  if (data && data.event_type !== "Log") console.log(`EVENT ${JSON.stringify(data)}`);
}
