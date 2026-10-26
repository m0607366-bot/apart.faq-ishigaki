// リンクカード用に、URLのタイトル・説明・画像を取り出す
import { getEmDashEntry } from "emdash";
import { excerptOf, slugCandidates } from "./site";

export interface LinkMeta {
	url: string;
	title: string;
	description: string;
	image?: string;
	site: string;
}

const SELF_HOSTS = new Set(["apart.faq-ishigaki.com", "localhost", "apart-faq-ishigaki-com.delta-a.workers.dev"]);

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function metaContent(html: string, key: string): string | undefined {
	const re = new RegExp(
		`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
		"i",
	);
	const m = html.match(re);
	const v = m?.[1] ?? m?.[2];
	return v ? decodeEntities(v.trim()) : undefined;
}

function firstImage(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const b of content as any[]) {
		if (b?._type === "image") return b.asset?.url ?? b.asset?.src ?? b.src;
	}
	return undefined;
}

/** 自分のサイトの記事・固定ページは、データベースから直接読む */
async function selfMeta(u: URL): Promise<LinkMeta | null> {
	const slug = decodeURIComponent(u.pathname.replace(/^\/|\/$/g, ""));
	if (!slug || slug.includes("/")) return null;
	for (const s of slugCandidates(slug)) {
		for (const col of ["posts", "pages"] as const) {
			const { entry } = await getEmDashEntry(col, s);
			if (entry) {
				const data: any = entry.data;
				return {
					url: u.toString(),
					title: data.title ?? u.toString(),
					description: excerptOf(data.content, 80),
					image: data.featured_image?.src ?? firstImage(data.content),
					site: "石垣島マンション・アパート一覧",
				};
			}
		}
	}
	return null;
}

/** 外部サイトは、ページのOGP（og:title など）を取得する。Cloudflareで1週間キャッシュ */
async function remoteMeta(u: URL): Promise<LinkMeta | null> {
	try {
		const res = await fetch(u.toString(), {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; LinkCardBot/1.0; +https://apart.faq-ishigaki.com/)", Accept: "text/html" },
			redirect: "follow",
			signal: AbortSignal.timeout(2500),
			// @ts-ignore Cloudflare固有のキャッシュ指定
			cf: { cacheTtl: 604800, cacheEverything: true },
		});
		if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
		const html = (await res.text()).slice(0, 300_000);
		const head = html.split(/<\/head>/i)[0] ?? html;
		const title =
			metaContent(head, "og:title") ??
			metaContent(head, "twitter:title") ??
			decodeEntities(head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "");
		if (!title) return null;
		const description =
			metaContent(head, "og:description") ?? metaContent(head, "description") ?? metaContent(head, "twitter:description") ?? "";
		let image = metaContent(head, "og:image") ?? metaContent(head, "twitter:image");
		// OGP画像がないページは、本文中の最初の写真を使う
		if (!image) {
			const body = html.slice(head.length);
			const m = body.match(/<img[^>]+src=["']([^"']+\/wp-content\/uploads\/[^"']+\.(?:jpe?g|png|webp))["']/i) ?? body.match(/<img[^>]+src=["'](https?:[^"']+\.(?:jpe?g|png|webp))["']/i);
			if (m) image = decodeEntities(m[1]);
		}
		if (image) image = new URL(image, u).toString();
		const site = metaContent(head, "og:site_name") ?? u.hostname;
		return { url: u.toString(), title, description, image, site };
	} catch {
		return null;
	}
}

/** 外部サイトの取得結果は、Cloudflareのキャッシュに30日保存して、毎回取りに行かない */
const META_CACHE_PREFIX = "https://linkmeta.internal/v1/";
async function cachedRemoteMeta(u: URL): Promise<LinkMeta | null> {
	const cache: Cache | undefined = (globalThis as any).caches?.default;
	const key = META_CACHE_PREFIX + encodeURIComponent(u.toString());
	if (cache) {
		try {
			const hit = await cache.match(key);
			if (hit) return (await hit.json()) as LinkMeta | null;
		} catch {}
	}
	const meta = await remoteMeta(u);
	if (cache) {
		try {
			// 取得できなかったページも1日だけ覚えておく（毎回待たないため）
			const ttl = meta ? 2_592_000 : 86_400;
			await cache.put(key, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } }));
		} catch {}
	}
	return meta;
}

export async function getLinkMeta(rawUrl: string): Promise<LinkMeta> {
	let u: URL;
	try {
		u = new URL(rawUrl);
	} catch {
		return { url: rawUrl, title: rawUrl, description: "", site: "" };
	}
	const meta = SELF_HOSTS.has(u.hostname) ? await selfMeta(u) : await cachedRemoteMeta(u);
	return meta ?? { url: u.toString(), title: u.toString(), description: "", site: u.hostname };
}
