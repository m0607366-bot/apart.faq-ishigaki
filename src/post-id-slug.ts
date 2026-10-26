/**
 * 投稿のURLを WordPress と同じ「数字だけ」（/22397/）にする
 * - 新しい投稿を作ったとき（POST /_emdash/api/content/posts）: スラッグを「今ある一番大きい番号 + 1」にする
 * - 保存のとき（PUT /_emdash/api/content/posts/{id}）: タイトルから作られた文字のスラッグが来ても、数字のスラッグを保つ
 *   まだ数字でない投稿は、このとき番号を振り直す
 * 固定ページ（pages）は対象外（/visa/ のような名前のURLのまま）
 */
import { defineMiddleware } from "astro:middleware";
import { getDb } from "emdash/runtime";
import { sql } from "kysely";

const BASE = "/_emdash/api/content/posts";
const NUMERIC = /^\d+$/;

async function nextNumber(): Promise<string> {
	const db = await getDb();
	const row = await sql<{ n: number | null }>`SELECT MAX(CAST(slug AS INTEGER)) AS n FROM ec_posts WHERE slug GLOB '[0-9]*' AND slug NOT GLOB '*[^0-9]*'`.execute(db);
	return String((Number(row.rows[0]?.n) || 0) + 1);
}

async function currentSlug(id: string): Promise<string | null> {
	const db = await getDb();
	const row = await sql<{ slug: string | null }>`SELECT slug FROM ec_posts WHERE id = ${id} LIMIT 1`.execute(db);
	return row.rows[0]?.slug ?? null;
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { request } = context;
	const path = new URL(request.url).pathname.replace(/\/$/, "");
	const isCreate = request.method === "POST" && path === BASE;
	const updateId = request.method === "PUT" && path.startsWith(BASE + "/") ? path.slice(BASE.length + 1) : null;
	if (!isCreate && !(updateId && !updateId.includes("/"))) return next();
	if (!(request.headers.get("content-type") ?? "").includes("application/json")) return next();

	try {
		const body = (await request.clone().json()) as Record<string, unknown>;
		let slug: string | null = null;
		if (isCreate) {
			if (typeof body.slug === "string" && NUMERIC.test(body.slug)) return next();
			slug = await nextNumber();
		} else {
			const cur = await currentSlug(updateId!);
			const wanted = typeof body.slug === "string" ? body.slug : null;
			if (cur && NUMERIC.test(cur)) {
				// 数字のまま。文字のスラッグに変えようとした場合だけ元に戻す
				if (wanted === null || wanted === cur || NUMERIC.test(wanted)) return next();
				slug = cur;
			} else if (cur !== null) {
				slug = wanted && NUMERIC.test(wanted) ? wanted : await nextNumber();
			} else return next();
		}
		const headers = new Headers(request.headers);
		headers.delete("content-length");
		return next(new Request(request.url, { method: request.method, headers, body: JSON.stringify({ ...body, slug }) }));
	} catch {
		return next();
	}
});
