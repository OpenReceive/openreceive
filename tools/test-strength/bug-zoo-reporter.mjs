// A node:test reporter for the bug zoo: one JSON line per failure, plus the
// stderr of files that could not even load. The zoo's table names the failing
// test from these lines; a test that only re-ran its parent suite's failure is
// dropped because its own subtest is already listed.

export default async function* bugZooReporter(source) {
  for await (const event of source) {
    if (event.type === "test:stderr") {
      yield `${JSON.stringify({ type: "stderr", file: event.data.file, message: event.data.message })}\n`;
      continue;
    }
    if (event.type !== "test:fail") continue;
    const { details, file, line, name, nesting } = event.data;
    const error = details?.error;
    const cause = error?.cause;
    if (error?.failureType === "subtestsFailed") continue;
    yield `${JSON.stringify({
      type: "fail",
      file,
      line,
      name,
      nesting,
      kind: error?.failureType,
      message: String(cause?.message ?? cause ?? error?.message ?? "").slice(0, 2000),
    })}\n`;
  }
}
