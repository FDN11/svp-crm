/**
 * Скрипты, шаблоны писем, возражения — один документ. По умолчанию из public/scripts-data.js,
 * после первой правки в интерфейсе — из таблицы settings (key scripts_json).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { db, log } from "./db.js";
import { getSetting, setSetting } from "./sequences.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
export function defaultScripts() {
  const ctx = { window: {} }; vm.runInNewContext(readFileSync(join(ROOT, "public", "scripts-data.js"), "utf8"), ctx); return ctx.window.SCRIPTS;
}
export function getScripts() {
  const raw = getSetting("scripts_json");
  if (raw) { try { return JSON.parse(raw); } catch {} }
  return defaultScripts();
}
export function scriptsRoutes(app) {
  app.get("/api/scripts", (_req, res) => res.json({ ...getScripts(), _custom: !!getSetting("scripts_json") }));
  app.put("/api/scripts", (req, res) => {
    if (!req.user?.is_admin) return res.status(403).json({ error: "только администратор" });
    const b = req.body || {};
    for (const k of ["facts", "call", "pitches", "objections", "emails", "attachments", "questions"]) if (b[k] && !Array.isArray(b[k])) return res.status(400).json({ error: `${k} должен быть списком` });
    const cur = getScripts(); const next = { ...cur, ...b }; delete next._custom;
    setSetting("scripts_json", JSON.stringify(next));
    log("user", req.user.id, "system", "Скрипты и шаблоны обновлены");
    res.json({ ok: true });
  });
  app.post("/api/scripts/reset", (req, res) => { if (!req.user?.is_admin) return res.status(403).json({ error: "только администратор" }); db.prepare(`DELETE FROM settings WHERE key = 'scripts_json'`).run(); res.json({ ok: true }); });
}
