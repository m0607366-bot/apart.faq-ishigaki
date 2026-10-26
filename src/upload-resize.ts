/**
 * 写真をアップロードしたときに、長辺を1200pxまで自動で縮小する（WordPressのプラグインと同じ動き）
 * - 管理画面からのアップロード（POST /_emdash/api/media）だけが対象
 * - JPEG / PNG / WebP / HEIC（iPhoneの写真）に対応。HEICはJPEGに変換
 * - 縮小にはCloudflareの画像変換（IMAGES）を使う。失敗したときは元の画像のまま保存
 * - astro.config.mjs の emdash({ middleware: { outer } }) で読み込んでいる
 */
import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

const MAX_SIDE = 1200;
const QUALITY = 85;
const UPLOAD_PATH = "/_emdash/api/media";
const RESIZED_HEADER = "x-diver-resized";

const RESIZABLE = /^image\/(jpeg|png|webp|heic|heif)$/i;

export const onRequest = defineMiddleware(async (context, next) => {
	const { request } = context;
	if (request.method !== "POST" || request.headers.get(RESIZED_HEADER)) return next();

	// 管理画面は通常「署名付きURL」で直接アップロードするが、それだとサイズを変えられない。
	// 写真の場合だけ「対応していない(501)」と返して、通常のアップロード（下の処理）に切り替えてもらう
	if (new URL(request.url).pathname.replace(/\/$/, "") === `${UPLOAD_PATH}/upload-url`) {
		try {
			const meta = (await request.clone().json()) as { contentType?: string };
			if (RESIZABLE.test(meta?.contentType ?? "") && (env as any)?.IMAGES) {
				return new Response(JSON.stringify({ success: false, error: { code: "NOT_IMPLEMENTED", message: "Use direct upload" } }), {
					status: 501,
					headers: { "Content-Type": "application/json" },
				});
			}
		} catch {}
		return next();
	}
	if (new URL(request.url).pathname.replace(/\/$/, "") !== UPLOAD_PATH) return next();
	if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) return next();

	const images = (env as any)?.IMAGES;
	if (!images) return next();

	let form: FormData;
	try {
		form = await request.clone().formData();
	} catch {
		return next();
	}
	const file = form.get("file");
	if (!(file instanceof File) || !RESIZABLE.test(file.type)) return next();

	try {
		const info = await images.info(file.stream());
		const width = Number(info?.width) || 0;
		const height = Number(info?.height) || 0;
		const isHeic = /hei[cf]/i.test(file.type);
		if (!isHeic && Math.max(width, height) <= MAX_SIDE) return next();

		const format = file.type === "image/png" ? "image/png" : file.type === "image/webp" ? "image/webp" : "image/jpeg";
		const result = await images
			.input(file.stream())
			.transform({ width: MAX_SIDE, height: MAX_SIDE, fit: "scale-down" })
			.output({ format, quality: QUALITY });
		const blob = await result.response().blob();

		const scale = width && height ? Math.min(1, MAX_SIDE / Math.max(width, height)) : 1;
		const newW = Math.round(width * scale);
		const newH = Math.round(height * scale);
		const name = isHeic ? file.name.replace(/\.(heic|heif)$/i, ".jpg") : file.name;
		const resized = new File([blob], name, { type: format });

		const body = new FormData();
		for (const [key, value] of form.entries()) {
			if (key === "file") body.append("file", resized);
			else if (key === "width" && newW) body.append("width", String(newW));
			else if (key === "height" && newH) body.append("height", String(newH));
			else body.append(key, value);
		}
		if (!form.has("width") && newW) body.append("width", String(newW));
		if (!form.has("height") && newH) body.append("height", String(newH));

		const headers = new Headers(request.headers);
		headers.delete("content-type");
		headers.delete("content-length");
		headers.set(RESIZED_HEADER, "1");
		return next(new Request(request.url, { method: "POST", headers, body }));
	} catch (error) {
		console.warn("[resize] 画像の縮小に失敗したため、元の画像のまま保存します", error);
		return next();
	}
});
