/** Импорт лидов из JSON парсинга: node scripts/import-leads.js <файл.json> [url] [user:pass] */
import { readFileSync } from "node:fs";
const [file, url = "http://localhost:3000", auth] = process.argv.slice(2);
if (!file) { console.error("укажите файл с лидами"); process.exit(1); }
const items = JSON.parse(readFileSync(file, "utf8"));
const headers = { "Content-Type": "application/json" };
if (auth) headers.Authorization = "Basic " + Buffer.from(auth).toString("base64");
const res = await fetch(`${url}/api/leads/import`, { method: "POST", headers, body: JSON.stringify(items) });
console.log(await res.json());
