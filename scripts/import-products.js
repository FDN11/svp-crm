/** Импорт товаров из дилерского прайса сайта: node scripts/import-products.js <price-list.json> [url] [user:pass] */
import { readFileSync } from "node:fs";
const [file, url = "http://localhost:3000", auth] = process.argv.slice(2);
if (!file) { console.error("укажите price-list.json"); process.exit(1); }
const items = JSON.parse(readFileSync(file, "utf8"));
const headers = { "Content-Type": "application/json" };
if (auth) {  // auth = логин:пароль → сессия
  const [login, ...pw] = auth.split(":");
  const r = await fetch(`${url}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ login, password: pw.join(":") }) });
  if (!r.ok) { console.error("вход не удался:", await r.text()); process.exit(1); }
  headers.Cookie = r.headers.get("set-cookie").split(";")[0];
}
const res = await fetch(`${url}/api/products/import`, { method: "POST", headers, body: JSON.stringify(items) });
console.log(await res.json());
