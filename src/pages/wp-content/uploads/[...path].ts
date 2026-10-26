/**
 * WordPress時代の画像URL（/wp-content/uploads/2025/08/xxx-1024x768.jpg）を
 * EmDashに移した画像へ転送する。
 * 他のサイト・SNS・Google画像検索などに残っている古い画像リンクを切らさないため。
 */
import type { APIRoute } from "astro";
import { getDb } from "emdash/runtime";

export const prerender = false;

export const GET: APIRoute = async ({ params, redirect }) => {
	const path = params.path ?? "";
	const file = decodeURIComponent(path.split("/").pop() ?? "");
	if (!file) return new Response("Not found", { status: 404 });

	// WordPressが作るサイズ違い（-1024x768）や -scaled を外した元のファイル名も候補にする
	const original = file.replace(/(-\d+x\d+|-scaled|-e\d{10,})+(?=\.[A-Za-z0-9]+$)/, "");
	// 大きな画像はWordPressが「-scaled」付きで保存していることがある
	const scaled = original.replace(/(\.[A-Za-z0-9]+)$/, "-scaled$1");
	const names = [...new Set([file, original, scaled])];

	const db = await getDb();

	const row = await db
		.selectFrom("media")
		.select(["storage_key"])
		.where("filename", "in", names)
		.where("status", "=", "ready")
		.orderBy("created_at", "asc")
		.executeTakeFirst();

	if (!row?.storage_key) return new Response("Not found", { status: 404 });

	const res = redirect(`/_emdash/api/media/file/${row.storage_key}`, 301);
	res.headers.set("Cache-Control", "public, max-age=86400");
	return res;
};
