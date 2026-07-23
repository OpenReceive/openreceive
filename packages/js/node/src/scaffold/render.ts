import { renderDrizzleFiles } from "./orms/drizzle.ts";
import { renderKnexFiles } from "./orms/knex.ts";
import { renderPrismaFiles } from "./orms/prisma.ts";
import { renderSequelizeFiles } from "./orms/sequelize.ts";
import { renderTypeOrmFiles } from "./orms/typeorm.ts";
import type { ScaffoldFile, ScaffoldPaymentsOptions } from "./types.ts";

export function renderScaffoldPaymentsFiles(
  options: ScaffoldPaymentsOptions,
): ScaffoldFile[] {
  switch (options.orm) {
    case "prisma":
      return renderPrismaFiles(options);
    case "drizzle":
      return renderDrizzleFiles(options);
    case "typeorm":
      return renderTypeOrmFiles(options);
    case "sequelize":
      return renderSequelizeFiles(options);
    case "knex":
      return renderKnexFiles(options);
  }
}
