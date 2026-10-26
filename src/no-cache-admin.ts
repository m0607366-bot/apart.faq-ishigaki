/**
 * 管理画面（/_emdash/…）の「ログイン画面へ移動」などの転送を、ブラウザに覚えさせない
 * - ログイン前に受け取った転送をブラウザがキャッシュすると、ログインに成功しても
 *   管理画面を開くたびにログイン画面へ戻され続けることがあった（Windows の Chrome で発生）
 */
import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
	const response = await next();
	const path = new URL(context.request.url).pathname;
	if (!path.startsWith("/_emdash/")) return response;
	if (response.status < 300 || response.status >= 400) return response;
	const res = new Response(response.body, response);
	res.headers.set("Cache-Control", "no-store, private");
	res.headers.set("CDN-Cache-Control", "no-store");
	return res;
});
