/** Создать пользователя: node scripts/add-user.js <login> <Имя> <пароль> [--admin] */
import { createUser } from "../auth.js";
const [login, name, password] = process.argv.slice(2);
if (!login || !name || !password) { console.error("использование: node scripts/add-user.js <login> <Имя> <пароль> [--admin]"); process.exit(1); }
console.log(createUser({ login, name, password, is_admin: process.argv.includes("--admin") ? 1 : 0 }));
