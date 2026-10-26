/**
 * ログイン情報（Astro のセッション）を Cloudflare D1 に保存するドライバー
 *
 * 初期設定では Cloudflare KV に保存されるが、KV は書き込みが世界中に届くまで最大1分ほどかかり、
 * ログイン直後に別の拠点へつながると「ログインしていない」と判定されて、ログイン画面に戻され続けることがあった。
 * D1 は書いた直後から必ず読めるので、この問題が起きない。
 * astro.config.mjs の session.driver で読み込んでいる。
 */
import { defineDriver } from "unstorage";
import { env } from "cloudflare:workers";

const TABLE = "_site_sessions";
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60日使われていないものは掃除する

let ready: Promise<unknown> | undefined;

function db(): any {
	const d = (env as any)?.DB;
	if (!d) throw new Error("D1 binding 'DB' not found");
	return d;
}
function ensure() {
	ready ??= db()
		.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`)
		.run()
		.catch((e: unknown) => {
			ready = undefined;
			throw e;
		});
	return ready;
}

export default defineDriver(() => ({
	name: "d1-sessions",
	async hasItem(key: string) {
		await ensure();
		return !!(await db().prepare(`SELECT 1 FROM ${TABLE} WHERE key = ?`).bind(key).first());
	},
	async getItem(key: string) {
		await ensure();
		const row = await db().prepare(`SELECT value FROM ${TABLE} WHERE key = ?`).bind(key).first();
		return row ? (row as any).value : null;
	},
	async setItem(key: string, value: string) {
		await ensure();
		const now = Date.now();
		await db()
			.prepare(
				`INSERT INTO ${TABLE} (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.bind(key, typeof value === "string" ? value : JSON.stringify(value), now)
			.run();
		// たまに古いものを掃除
		if (Math.random() < 0.02) {
			await db().prepare(`DELETE FROM ${TABLE} WHERE updated_at < ?`).bind(now - MAX_AGE_MS).run().catch(() => {});
		}
	},
	async removeItem(key: string) {
		await ensure();
		await db().prepare(`DELETE FROM ${TABLE} WHERE key = ?`).bind(key).run();
	},
	async getKeys() {
		await ensure();
		const r = await db().prepare(`SELECT key FROM ${TABLE}`).all();
		return (r.results ?? []).map((x: any) => x.key);
	},
	async clear() {
		await ensure();
		await db().prepare(`DELETE FROM ${TABLE}`).run();
	},
}));
