/** Импорт товаров из дилерского прайса сайта: node scripts/import-products.js <price-list.json> */
import { readFileSync } from "node:fs";
import { db } from "../db.js";
const file = process.argv[2];
if (!file) { console.error("укажите price-list.json"); process.exit(1); }
const items = JSON.parse(readFileSync(file, "utf8"));
const up = db.prepare(`
  INSERT INTO products (sku, name, group_name, pack_type, price, rrc, weight_kg)
  VALUES (@sku, @name, @group_name, @pack_type, @price, @rrc, @weight_kg)
  ON CONFLICT(sku) DO UPDATE SET name=excluded.name, group_name=excluded.group_name, pack_type=excluded.pack_type,
    price=excluded.price, rrc=excluded.rrc, weight_kg=excluded.weight_kg, active=1`);
let n = 0;
for (const p of items) {
  up.run({ sku: String(p.eanRu || p.eanIntl || p.name), name: p.name, group_name: p.group, pack_type: p.packType,
           price: Number(p.priceTotal) || 0, rrc: Number(p.rrc) || null, weight_kg: Number(p.weightKg) || null });
  n++;
}
console.log(`товаров загружено/обновлено: ${n}`);
