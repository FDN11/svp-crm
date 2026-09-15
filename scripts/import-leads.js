/** Импорт лидов из JSON парсинга: node scripts/import-leads.js <файл.json> [url] */
import { readFileSync } from "node:fs";
const file = process.argv[2];
const url = process.argv[3] || "http://localhost:3000";
if (!file) { console.error("укажите файл с лидами"); process.exit(1); }
const items = JSON.parse(readFileSync(file, "utf8"));
const res = await fetch(`${url}/api/leads/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(items) });
console.log(await res.json());
