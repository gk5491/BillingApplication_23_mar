import { defineConfig } from "drizzle-kit";

const databaseServerRaw = process.env.DATABASE_SERVER || "DESKTOP-9LSMK42\\SQLEXPRESS";
const databaseInstance =
  process.env.DATABASE_INSTANCE || (databaseServerRaw.includes("\\") ? databaseServerRaw.split("\\")[1] : undefined);
const databasePort = process.env.DATABASE_PORT ? Number(process.env.DATABASE_PORT) : undefined;
const databaseServerHost = databaseServerRaw.includes("\\") ? databaseServerRaw.split("\\")[0] : databaseServerRaw;
const databaseServer = databaseServerHost === "." || databaseServerHost.toLowerCase() === "(local)" ? "localhost" : databaseServerHost;

export default defineConfig({
  out: "./drizzle",
  schema: "./shared/schema.ts",
  dialect: "mssql",
  dbCredentials: {
    server: databaseServer,
    database: process.env.DATABASE_NAME || "billing_application",
    authentication: {
      type: "default",
      options: {
        trustedConnection: true,
      },
    },
    options: {
      encrypt: (process.env.DATABASE_ENCRYPT || "false").toLowerCase() === "true",
      trustServerCertificate: true,
      ...(databaseInstance && !databasePort ? { instanceName: databaseInstance } : {}),
    },
    ...(databasePort ? { port: databasePort } : {}),
  },
});
