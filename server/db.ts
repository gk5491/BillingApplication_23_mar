import mssql from "mssql/msnodesqlv8.js";
const databaseServerRaw = process.env.DATABASE_SERVER || "LAPTOP-4M368TIF\\SQLEXPRESS";
const databaseName = process.env.DATABASE_NAME || "billing_application";
const databaseInstance =
  process.env.DATABASE_INSTANCE || (databaseServerRaw.includes("\\") ? databaseServerRaw.split("\\")[1] : undefined);
const databasePort = process.env.DATABASE_PORT ? Number(process.env.DATABASE_PORT) : undefined;
const databaseServerHost = databaseServerRaw.includes("\\") ? databaseServerRaw.split("\\")[0] : databaseServerRaw;
const databaseServer = databaseServerHost === "." || databaseServerHost.toLowerCase() === "(local)" ? "localhost" : databaseServerHost;
const windowsAuth = (process.env.DATABASE_WINDOWS_AUTH || "true").toLowerCase() === "true";
const databaseEncrypt = (process.env.DATABASE_ENCRYPT || "true").toLowerCase() === "true";
const trustServerCertificate = (process.env.DATABASE_TRUST_SERVER_CERTIFICATE || "true").toLowerCase() === "true";

const buildConfig = (server: string): any => {
  const fullServer = databaseInstance && !databasePort ? `${server}\\${databaseInstance}` : server;
  let connectionString = `Driver={ODBC Driver 17 for SQL Server};Server=${fullServer};Database=${databaseName};Trusted_Connection=yes;`;

  if (databaseEncrypt) {
    connectionString += "Encrypt=yes;";
  } else {
    connectionString += "Encrypt=no;";
  }

  if (trustServerCertificate) {
    connectionString += "TrustServerCertificate=yes;";
  }

  return { connectionString };
};

async function connectWithFallback() {
  const hosts = [databaseServer, "localhost", "127.0.0.1"].filter((v, i, arr) => arr.indexOf(v) === i);
  let lastError: unknown;

  for (const host of hosts) {
    try {
      const config = buildConfig(host);
      console.log(`Trying to connect to MSSQL host: ${host}, database: ${databaseName}, user: ${config.user}`);
      return await mssql.connect(config);
    } catch (err: any) {
      console.error(`Failed to connect with host ${host}:`);
      console.dir(err, { depth: null });
      lastError = err;
    }
  }

  throw lastError;
}

async function ensureDeliveryChallanSchema() {
  const p = await getPool();
  await p.request().batch(`
    IF COL_LENGTH('delivery_challans', 'subtotal') IS NULL
      ALTER TABLE delivery_challans ADD subtotal DECIMAL(18, 2) NOT NULL CONSTRAINT DF_delivery_challans_subtotal DEFAULT 0;

    IF COL_LENGTH('delivery_challans', 'tax_amount') IS NULL
      ALTER TABLE delivery_challans ADD tax_amount DECIMAL(18, 2) NOT NULL CONSTRAINT DF_delivery_challans_tax_amount DEFAULT 0;

    IF COL_LENGTH('delivery_challans', 'total') IS NULL
      ALTER TABLE delivery_challans ADD total DECIMAL(18, 2) NOT NULL CONSTRAINT DF_delivery_challans_total DEFAULT 0;

    IF COL_LENGTH('delivery_challan_items', 'rate') IS NULL
      ALTER TABLE delivery_challan_items ADD rate DECIMAL(18, 2) NOT NULL CONSTRAINT DF_delivery_challan_items_rate DEFAULT 0;

    IF COL_LENGTH('delivery_challan_items', 'tax_rate_id') IS NULL
      ALTER TABLE delivery_challan_items ADD tax_rate_id UNIQUEIDENTIFIER NULL;

    IF COL_LENGTH('delivery_challan_items', 'tax_amount') IS NULL
      ALTER TABLE delivery_challan_items ADD tax_amount DECIMAL(18, 2) NOT NULL CONSTRAINT DF_delivery_challan_items_tax_amount DEFAULT 0;

    IF COL_LENGTH('delivery_challan_items', 'amount') IS NULL
      ALTER TABLE delivery_challan_items ADD amount DECIMAL(18, 2) NOT NULL CONSTRAINT DF_delivery_challan_items_amount DEFAULT 0;
  `);
}

let pool: any;

export async function getPool() {
  if (!pool) {
    pool = await connectWithFallback();
  }
  return pool;
}

export async function getDb() {
  if (!pool) {
    throw new Error("MSSQL pool is not initialized yet");
  }
  return pool;
}

export async function initializeDb() {
  try {
    await getPool();
    await ensureDeliveryChallanSchema();
    console.log("Connected to MSSQL database:", databaseName);
    return true;
  } catch (err) {
    console.error("CRITICAL: Failed to connect to MSSQL database during initialization:");
    console.dir(err, { depth: null });
    throw err;
  }
}

export const db = {
  get pool() {
    return pool;
  },
  async request() {
    const p = await getPool();
    return p.request();
  },
  async query(strings: TemplateStringsArray, ...values: any[]) {
    const p = await getPool();
    const request = p.request();
    let queryArgs = "";
    strings.forEach((str, i) => {
      queryArgs += str;
      if (i < values.length) {
        request.input(`param${i}`, values[i]);
        queryArgs += `@param${i}`;
      }
    });
    return request.query(queryArgs);
  }
};
