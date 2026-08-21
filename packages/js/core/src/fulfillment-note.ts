import { FULFILLMENT_NOTE_TEMPLATE } from "./generated/fulfillment-note-text.ts";

/**
 * The ONE canonical statement of the order-table boundary and the host's
 * exactly-once fulfillment duty.
 *
 * OpenReceive treats `order_id` as an opaque string. It never reads, writes,
 * locks, or requires a foreign key to the host's order table, and it does not
 * need to know that table's name or its primary-key type. Everything the
 * library serializes, it serializes on rows it owns.
 *
 * That boundary means the exactly-once guarantee has a documented edge, and
 * this note is where it is documented. Every generated file, migration
 * template, and wiring guide renders these same lines through
 * `openReceiveFulfillmentNote`, so the guidance shown next to host code can
 * never drift from the guidance shown next to the schema.
 *
 * The text itself lives in `spec/data/fulfillment-note.txt` and is generated
 * into both this module and its Ruby twin
 * (`OpenReceive::Generated::FULFILLMENT_NOTE_TEMPLATE`), so the scaffold CLI
 * and the Rails install generator cannot give different advice either.
 */

function fulfillmentNoteLines(tableName: string): readonly string[] {
  return FULFILLMENT_NOTE_TEMPLATE.map((line) => line.replaceAll("{{table}}", tableName));
}

/**
 * The canonical note, with every line given `prefix` (already including any
 * trailing space). Pass `"// "`, `"-- "`, or `"# "` for source comments, or
 * `""` for prose. Blank lines are emitted with the prefix trimmed, so no
 * comment block ends up with trailing whitespace a formatter would strip.
 */
export function openReceiveFulfillmentNote(
  prefix = "",
  tableName = "openreceive_payments",
): string {
  return fulfillmentNoteLines(tableName)
    .map((line) => (line.length === 0 ? prefix.trimEnd() : `${prefix}${line}`))
    .join("\n");
}

/**
 * The same note as markdown: the section headings become bold labels and the
 * indented blocks become fenced SQL, so it reads as documentation rather than
 * as a comment block that happens to be in a document.
 */
export function openReceiveFulfillmentNoteMarkdown(tableName = "openreceive_payments"): string {
  const out: string[] = [];
  let fenced = false;
  const closeFence = (): void => {
    // Trailing blanks belong after the fence, not inside it.
    while (out.at(-1) === "") out.pop();
    out.push("```", "");
    fenced = false;
  };
  for (const [index, line] of fulfillmentNoteLines(tableName).entries()) {
    if (index === 0) {
      out.push(`### ${line}`);
      continue;
    }
    const indented = line.startsWith("  ");
    if (indented && !fenced) {
      out.push("```sql");
      fenced = true;
    } else if (!indented && fenced && line.length > 0) {
      closeFence();
    }
    if (fenced) {
      out.push(line.slice(2));
      continue;
    }
    out.push(isHeading(line) ? `**${sentenceCase(line)}**` : line);
  }
  if (fenced) closeFence();
  return out.join("\n").trimEnd();
}

/** A note line written in all caps is a section heading, not prose. */
function isHeading(line: string): boolean {
  return line.length > 0 && line === line.toUpperCase() && /[A-Z]/.test(line);
}

function sentenceCase(line: string): string {
  return line.charAt(0) + line.slice(1).toLowerCase();
}
