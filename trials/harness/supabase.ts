import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { InfraError } from "./docker.ts";
import type { Check, Platform } from "./types.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CA_FILE = path.join(repoRoot, "tests/supabase/prod-ca-2021.crt");

/**
 * A trial on a real Supabase project: the variables its server gets, and the
 * database password, which is the maintainer's and so must stay out of every
 * report and never reach the agent.
 */
export interface SupabaseProject {
  readonly poolerUrl: string;
  readonly ca: string;
  readonly password: string;
  /** What the host sets in the shop server's environment. */
  readonly env: Readonly<Record<string, string>>;
}

/** Reads the pooler URL named by `supabase_project` from the repo-root .env. */
export async function loadSupabaseProject(
  platform: Platform,
  dotenvPath = path.join(repoRoot, ".env"),
): Promise<SupabaseProject | undefined> {
  const name = platform.supabase_project;
  if (name === undefined) return undefined;
  const dotenv = await readFile(dotenvPath, "utf8").catch(() => "");
  const line = dotenv.split("\n").find((entry) => entry.startsWith(`${name}=`));
  const poolerUrl = line?.slice(name.length + 1).trim() ?? "";
  if (poolerUrl === "")
    throw new InfraError(`Set ${name} (the transaction pooler URL) in the repo-root .env.`);
  const password = decodeURIComponent(new URL(poolerUrl).password);
  if (password === "") throw new InfraError(`${name} has no password.`);
  const ca = await readFile(CA_FILE, "utf8");
  return { poolerUrl, ca, password, env: { DATABASE_URL: poolerUrl, SUPABASE_CA_CERT: ca } };
}

/** The guide's Node connection: no sslmode in the URL, Supabase's CA as ssl.ca. */
async function withClient<T>(project: SupabaseProject, use: (client: pg.Client) => Promise<T>) {
  const url = new URL(project.poolerUrl);
  url.searchParams.delete("sslmode");
  const client = new pg.Client({ connectionString: url.toString(), ssl: { ca: project.ca } });
  await client.connect().catch((error: unknown) => {
    throw new InfraError(`Supabase pooler: ${error instanceof Error ? error.message : error}`);
  });
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/**
 * Empties the project's public schema, so each run starts on a database that
 * holds nothing but what the plain shop creates. The schema itself stays:
 * Supabase's default grants to anon and authenticated live on it, and the
 * privacy check below needs a new table to get them, as on a real project.
 */
export async function resetSupabase(project: SupabaseProject): Promise<void> {
  await withClient(project, async (client) => {
    const { rows } = await client.query<{ statement: string }>(`
      select format('drop %s if exists %s cascade', kind, name) as statement
      from (
        select case c.relkind when 'v' then 'view' when 'm' then 'materialized view'
                              when 'S' then 'sequence' else 'table' end as kind,
               c.oid::regclass::text as name
        from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')
          and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('e', 'a', 'i'))
        union all
        select 'function', p.oid::regprocedure::text
        from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        union all
        select 'type', t.oid::regtype::text
        from pg_type t
        where t.typnamespace = 'public'::regnamespace and t.typtype in ('e', 'd')
          and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
      ) objects`);
    for (const { statement } of rows) await client.query(statement);
  });
}

/**
 * Step 3 of the Supabase guide: OpenReceive's tables are closed to Supabase's
 * Data API. Row level security is on, and anon and authenticated, the roles
 * every visitor's browser can act as, hold no privilege on them.
 */
export async function supabaseChecks(project: SupabaseProject): Promise<Check> {
  const rows = await withClient(project, async (client) => {
    const result = await client.query<{ name: string; rls: boolean; open: string[] }>(`
      select c.relname as name, c.relrowsecurity as rls,
             array_remove(array[
               case when has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE') then 'anon' end,
               case when has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE') then 'authenticated' end
             ], null) as open
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and c.relname like 'openreceive\\_%'
      order by c.relname`);
    return result.rows;
  }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  const summary =
    "OpenReceive's tables are closed to Supabase's Data API: row level security on, and no privilege for anon or authenticated.";
  if (typeof rows === "string")
    return {
      id: "supabase_tables_private",
      severity: "blocker",
      pass: false,
      summary,
      evidence: rows,
    };
  const exposed = rows.filter((row) => !row.rls || row.open.length > 0);
  const evidence =
    rows.length === 0
      ? "no openreceive_ table in the public schema"
      : exposed
          .map(
            (row) =>
              `${row.name}: ${[!row.rls ? "row level security off" : "", ...row.open.map((role) => `${role} has access`)].filter(Boolean).join(", ")}`,
          )
          .join("; ");
  return {
    id: "supabase_tables_private",
    severity: "blocker",
    pass: rows.length > 0 && exposed.length === 0,
    summary,
    evidence: evidence === "" ? undefined : evidence,
  };
}
