import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";
import { fileURLToPath } from "node:url";


// 表示を速くするためのページキャッシュ（記事の公開・更新、カテゴリー・ウィジェットの変更で自動的に更新される）
const pageCache = {
	maxAge: 86_400, // 1日
	swr: 604_800, // 更新中は古いページを最大7日表示
	tags: ["posts", "pages", "emdash:taxonomy:category", "emdash:widget-area:sidebar", "emdash:settings", "emdash:menu:main", "all"],
};

export default defineConfig({
	output: "server",
	// ログイン情報は D1 に保存（KV だと反映待ちでログイン画面に戻され続けることがあるため）
	session: {
		driver: { entrypoint: fileURLToPath(new URL("./src/session-d1.ts", import.meta.url)), config: {} },
	},
	adapter: cloudflare(),
	cache: {
		provider: cacheCloudflare(),
	},
	routeRules: {
		"/": pageCache,
		"/[slug]": pageCache,
		"/[slug]/[page]": pageCache,
		"/posts/[slug]": pageCache,
		"/pages/[slug]": pageCache,
		"/category/[...path]": pageCache,
		"/page/[n]": pageCache,
		"/date/[...path]": pageCache,
		"/rss.xml": pageCache,
	},
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto", coalesce: true }),
			storage: r2({ binding: "MEDIA" }),
			// キャッシュしたページでも、ログイン中は編集ボタンを表示
			toolbar: "client",
			// 写真アップロード時の自動縮小（長辺1200px）
			middleware: { outer: "./src/admin-middleware.ts" },
			// メールでのログイン（ログイン用リンクを Cloudflare Email Sending で送る。送信元は mail.delta-a.net）
			plugins: [
				cloudflareEmail({
					from: { email: "noreply@mail.delta-a.net", name: "石垣島マンション・アパート一覧" },
				}),
			],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
});
