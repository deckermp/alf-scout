// src/db.mjs — the SQLite handle the research store writes through.
//
// In the private harness this feature was extracted from, this module hands back
// a long-lived ledger that many subsystems share. Standalone, it is just a local
// file; the research tables are created on demand by src/research/store.mjs.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.ALF_DB || path.join(DEFAULT_DIR, "alf-scout.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
// WAL keeps the fire-and-forget run writer from blocking dashboard reads.
db.pragma("journal_mode = WAL");

export const dbPath = DB_PATH;
