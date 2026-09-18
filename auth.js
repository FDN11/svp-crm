/**
 * Вход по логину и паролю, cookie-сессии, автор действий.
 * Ролей нет: is_admin только даёт право заводить пользователей.
 * Первый администратор создаётся из CRM_USER / CRM_PASS, если таблица пуста —
 * так текущий деплой продолжает работать без ручных шагов.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, requestContext, log } from "./db.js";

const SESSION_DAYS = 30;
const COOKIE = "svp_sid";

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}
function verify(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.pass_hash, "hex"));
}

export function createUser({ login, name, password, is_admin = 0 }) {
  if (!login || !password) throw new Error("login and password required");
  const { salt, hash } = hashPassword(password);
  const info = db.prepare(`INSERT INTO users (login, name, pass_hash, salt, is_admin) VALUES (?,?,?,?,?)`)
    .run(login.trim().toLowerCase(), name || login, hash, salt, is_admin ? 1 : 0);
  return publicUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid));
}
export const publicUser = (u) => u && { id: u.id, login: u.login, name: u.name, is_admin: !!u.is_admin, active: !!u.active, last_seen: u.last_seen };

/* первый запуск: админ из переменных окружения */
export function bootstrapAdmin() {
  const n = db.prepare(`SELECT COUNT(*) n FROM users`).get().n;
  if (n > 0) return;
  const login = process.env.CRM_USER, password = process.env.CRM_PASS;
  if (login && password) { createUser({ login, name: process.env.CRM_ADMIN_NAME || "Администратор", password, is_admin: 1 }); console.log(`создан администратор «${login}» из CRM_USER/CRM_PASS`); }
  else console.log("пользователей нет — создайте: node scripts/add-user.js <login> <имя> <пароль> [--admin]");
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
const isSecure = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
function setSession(res, req, sid, maxAgeSec) {
  res.append("Set-Cookie", `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isSecure(req) ? "; Secure" : ""}`);
}

export function login(req, res) {
  const { login, password } = req.body || {};
  const user = login && db.prepare(`SELECT * FROM users WHERE login = ? AND active = 1`).get(String(login).trim().toLowerCase());
  if (!user || !verify(String(password || ""), user)) return res.status(401).json({ error: "Неверный логин или пароль" });
  const sid = randomBytes(32).toString("hex");
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`).run(sid, user.id);
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  setSession(res, req, sid, SESSION_DAYS * 86400);
  res.json(publicUser(user));
}
export function logout(req, res) {
  const sid = parseCookies(req)[COOKIE];
  if (sid) db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  setSession(res, req, "", 0);
  res.json({ ok: true });
}

/* Кладёт пользователя в req.user и в контекст запроса (для автора в ленте).
   Пускает без сессии: вход, статику и вебхуки (у них свой токен). */
const OPEN = new Set(["/api/auth/login", "/api/health"]);
export function sessionMiddleware(req, res, next) {
  const sid = parseCookies(req)[COOKIE];
  const user = sid && db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > datetime('now') AND u.active = 1`).get(sid);
  req.user = publicUser(user) || null;
  if (user && (!user.last_seen || user.last_seen < new Date(Date.now() - 600000).toISOString().slice(0, 19).replace("T", " ")))
    db.prepare(`UPDATE users SET last_seen = datetime('now') WHERE id = ?`).run(user.id);
  const isApi = req.path.startsWith("/api/");
  if (isApi && !req.user && !OPEN.has(req.path) && !req.path.startsWith("/api/webhooks/")) return res.status(401).json({ error: "auth required" });
  requestContext.run({ user: req.user }, next);
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: "только для администратора" });
  next();
}

export function usersRoutes(app) {
  app.post("/api/auth/login", login);
  app.post("/api/auth/logout", logout);
  app.get("/api/auth/me", (req, res) => res.json(req.user));
  app.get("/api/users", (_req, res) => res.json(db.prepare(`SELECT * FROM users ORDER BY name`).all().map(publicUser)));
  app.post("/api/users", requireAdmin, (req, res) => {
    try { const u = createUser(req.body || {}); log("user", u.id, "system", `Пользователь ${u.login} создан`); res.status(201).json(u); }
    catch (e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? "такой логин уже есть" : e.message }); }
  });
  app.patch("/api/users/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id); const b = req.body || {};
    if ("password" in b && b.password) { const { salt, hash } = hashPassword(b.password); db.prepare(`UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?`).run(hash, salt, id); db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id); }
    if ("name" in b) db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(b.name, id);
    if ("active" in b && id !== req.user.id) db.prepare(`UPDATE users SET active = ? WHERE id = ?`).run(b.active ? 1 : 0, id);
    if ("is_admin" in b && id !== req.user.id) db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(b.is_admin ? 1 : 0, id);
    res.json(publicUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id)));
  });
  /* смена своего пароля */
  app.post("/api/auth/password", (req, res) => {
    const { current, password } = req.body || {};
    const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
    if (!verify(String(current || ""), u)) return res.status(400).json({ error: "текущий пароль неверен" });
    if (!password || password.length < 8) return res.status(400).json({ error: "новый пароль — минимум 8 символов" });
    const { salt, hash } = hashPassword(password);
    db.prepare(`UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?`).run(hash, salt, u.id);
    res.json({ ok: true });
  });
}
