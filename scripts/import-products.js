/** Импорт товаров из дилерского прайса сайта: node scripts/import-products.js <price-list.json> [url] [user:pass] */
import { readFileSync } from "node:fs";
const [file, url = "http://localhost:3000", auth] = process.argv.slice(2);
if (!file) { console.error("укажите price-list.json"); process.exit(1); }
const items = JSON.parse(readFileSync(file, "utf8"));
const headers = { "Content-Type": "application/json" };
if (auth) headers.Authorization = "Basic " + Buffer.from(auth).toString("base64");
const res = await fetch(`${url}/api/products/import`, { method: "POST", headers, body: JSON.stringify(items) });
console.log(await res.json());
