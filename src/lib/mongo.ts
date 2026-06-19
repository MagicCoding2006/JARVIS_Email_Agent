import { MongoClient, ServerApiVersion, type Db } from "mongodb";
import { config } from "../config/index.js";
import { createLogger } from "./logger.js";

const log = createLogger("mongo");

let client: MongoClient | null = null;
let db: Db | null = null;

/** Connect once and cache the client/db for the process lifetime. */
export async function getDb(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(config.mongo.uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false, // we create indexes; strict mode rejects some admin ops
      deprecationErrors: true,
    },
  });
  await client.connect();
  db = client.db(config.mongo.db);
  log.info(`connected to ${config.mongo.db}`);
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    log.info("connection closed");
  }
}
