import type { MigrationResultSet } from "kysely";

/**
 * Formats Kysely migration execution results into stable CLI output.
 */
export function formatMigrationResults(resultSet: MigrationResultSet): string {
  const lines = ["migrations"];

  for (const result of resultSet.results ?? []) {
    lines.push(`${result.status}: ${result.migrationName}`);
  }

  if (!resultSet.results || resultSet.results.length === 0) {
    lines.push("No migrations were executed.");
  }

  if (resultSet.error) {
    lines.push(`error: ${getErrorMessage(resultSet.error)}`);
  } else {
    lines.push("status: ok");
  }

  return lines.join("\n");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown migration error";
}
