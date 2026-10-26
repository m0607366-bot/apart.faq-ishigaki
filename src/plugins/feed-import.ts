/**
 * 不動産業者のフィード（RSS / RDF / Atom）から新着物件を記事として取り込むプラグイン
 * （WordPress で使っていたフィード取り込みプラグインの置き換え）
 *
 * - 毎日 13:00・19:00（日本時間）に巡回（astro.config.mjs の feedImport({ schedules }) で変更できる）
 * - 新しい物件は「タイトル＋『このサイトの記事を見る』リンク＋写真」の記事にして、すぐ公開する
 * - カテゴリーは「リンク切れは商談成立済」（slug: excel）、タグはフィードの名前（業者名）
 * - 一度取り込んだ物件（リンク先URL）は二度と取り込まない（初回は既存の記事のリンクから一覧を作る）
 * - 記事のURLは WordPress と同じ「数字だけ」（今ある一番大きい番号 + 1）
 * - 最初の1回は手動で動かす（それまで自動の巡回は休み。WordPress からの取り込み前に動いて二重にならないように）
 * - 手動で今すぐ巡回: 管理画面にログインした状態で POST /_emdash/api/plugins/feed-import/run
 *   状態の確認:                                   GET  /_emdash/api/plugins/feed-import/status
 *   リンク切れの確認を今すぐ:                     POST /_emdash/api/plugins/feed-import/linkcheck?limit=100
 * - 毎日 2:00〜3:50（日本時間）に10分ごと、リンク切れの物件の記事をゴミ箱へ（runLinkCheck）
 */
import type { PluginContext, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";
import { getDb } from "emdash/runtime";
import { sql } from "kysely";

export interface FeedImportConfig {
	/** 巡回するフィードのURL */
	feeds: string[];
	/** 巡回する時刻（cron 形式・UTC）。日本時間 13:00 = "0 4 * * *"、19:00 = "0 10 * * *" */
	schedules: string[];
	/** 取り込んだ記事に付けるカテゴリーの slug */
	category: string;
	/** 1回の巡回で1つのフィードから取り込む最大件数（初回や長く止まっていたときの暴走よけ） */
	maxPerFeed?: number;
	/** リンク切れの確認をする時刻（cron 形式・UTC）。1回で linkCheckBatch 件ずつ、記事全体を1日で一回りする */
	linkCheckSchedules?: string[];
	/** 1回のリンク確認で調べる記事の数 */
	linkCheckBatch?: number;
}

const ID = "feed-import";
const SEEN_KEY = "seen"; // 取り込み済みのリンク一覧
const LAST_KEY = "lastRun"; // 最後の巡回結果
const NUMERIC = /^\d+$/;

interface FeedItem {
	title: string;
	link: string;
	image?: string;
}
interface Feed {
	title: string;
	items: FeedItem[];
}

// ===== フィードの読み取り（DOM が使えないので正規表現で） =====
function decodeEntities(s: string): string {
	return s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;|&#039;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}
function tagText(xml: string, tag: string): string {
	const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
	return m ? decodeEntities(m[1]).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
}
function tagRaw(xml: string, tag: string): string {
	const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
	return m ? decodeEntities(m[1]) : "";
}
function attr(tagSrc: string, name: string): string {
	const m = tagSrc.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"));
	return m ? decodeEntities(m[1]).trim() : "";
}
function firstImage(xml: string): string | undefined {
	for (const re of [/<enclosure\b[^>]*>/gi, /<media:content\b[^>]*>/gi, /<media:thumbnail\b[^>]*>/gi]) {
		for (const m of xml.matchAll(re)) {
			const url = attr(m[0], "url");
			const type = attr(m[0], "type");
			if (url && (!type || type.startsWith("image")) && /^https?:/i.test(url)) return url;
		}
	}
	for (const field of ["content:encoded", "description", "content", "summary"]) {
		const html = tagRaw(xml, field);
		const m = html.match(/<img\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
		if (m && /^https?:/i.test(m[1])) return decodeEntities(m[1]);
	}
	return undefined;
}
export function parseFeed(xml: string): Feed {
	const items: FeedItem[] = [];
	const blocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
	const isAtom = blocks.length === 0;
	if (isAtom) blocks.push(...[...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]));
	for (const b of blocks) {
		let link = "";
		if (isAtom) {
			const links = [...b.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
			const alt = links.find((l) => !/rel=/.test(l) || /rel=["']alternate["']/.test(l)) ?? links[0];
			link = alt ? attr(alt, "href") : "";
		} else {
			link = tagText(b, "link") || attr(b.match(/<link\b[^>]*>/i)?.[0] ?? "", "href") || tagText(b, "guid");
		}
		const title = tagText(b, "title");
		if (!link || !/^https?:/i.test(link)) continue;
		items.push({ title: title || link, link, image: firstImage(b) });
	}
	// フィードの名前: 最初の記事より前にある <title>
	const head = xml.split(/<item\b|<entry\b/i)[0] ?? "";
	return { title: tagText(head, "title"), items };
}

async function fetchFeed(ctx: PluginContext, url: string, timeoutMs = 20_000): Promise<Feed> {
	const doFetch = ctx.http ? ctx.http.fetch.bind(ctx.http) : fetch;
	const res = await doFetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; apart.faq-ishigaki.com feed reader)" }, signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	// 文字コード（Shift_JIS・EUC-JP のフィードもある）: XML宣言 → Content-Type → UTF-8
	const head = String.fromCharCode(...bytes.slice(0, 300));
	const enc =
		head.match(/encoding=["']([\w-]+)["']/i)?.[1] ??
		res.headers.get("content-type")?.match(/charset=([\w-]+)/i)?.[1] ??
		"utf-8";
	let xml: string;
	try {
		xml = new TextDecoder(enc.toLowerCase()).decode(bytes);
	} catch {
		xml = new TextDecoder("utf-8").decode(bytes);
	}
	return parseFeed(xml);
}

// ===== 取り込み済みの一覧 =====
function normalizeLink(u: string): string {
	return u.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").replace(/#.*$/, "");
}
function linksIn(value: unknown, out: string[]): void {
	if (Array.isArray(value)) for (const v of value) linksIn(v, out);
	else if (value && typeof value === "object") {
		const o = value as Record<string, unknown>;
		if (o._type === "link" && typeof o.href === "string") out.push(o.href);
		for (const v of Object.values(o)) linksIn(v, out);
	} else if (typeof value === "string") {
		for (const m of value.matchAll(/href=["']([^"']+)["']/g)) out.push(m[1]);
	}
}
async function loadSeen(ctx: PluginContext): Promise<Set<string>> {
	const saved = await ctx.kv.get<string[]>(SEEN_KEY);
	if (saved) return new Set(saved);
	// 初回: 今ある記事（WordPress から取り込んだもの）のリンクから作る
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (let i = 0; i < 200; i++) {
		const page = await ctx.content.list("posts", { limit: 100, cursor });
		for (const item of page.items) {
			const links: string[] = [];
			linksIn(item.data?.content, links);
			for (const l of links) seen.add(normalizeLink(l));
		}
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}
	await ctx.kv.set(SEEN_KEY, [...seen]);
	return seen;
}

// ===== 記事の作成 =====
let keyN = 0;
const key = () => `fi${Date.now().toString(36)}${(keyN++).toString(36)}`;
function buildContent(link: string) {
	const mark = key();
	return [
		{
			_type: "block",
			_key: key(),
			style: "normal",
			markDefs: [{ _type: "link", _key: mark, href: link, blank: true }],
			children: [{ _type: "span", _key: key(), text: "このサイトの記事を見る", marks: [mark] }],
		},
	];
}
async function nextNumber(): Promise<string> {
	const db = await getDb();
	const row = await sql<{ n: number | null }>`SELECT MAX(CAST(slug AS INTEGER)) AS n FROM ec_posts WHERE slug GLOB '[0-9]*' AND slug NOT GLOB '*[^0-9]*'`.execute(db);
	return String((Number(row.rows[0]?.n) || 0) + 1);
}
async function setSlug(id: string, slug: string): Promise<void> {
	const db = await getDb();
	await sql`UPDATE ec_posts SET slug = ${slug} WHERE id = ${id}`.execute(db);
}

async function termId(ctx: PluginContext, taxonomy: string, match: { slug?: string; label?: string }, create?: { label: string; slug: string }): Promise<string | null> {
	const terms = await ctx.taxonomies!.getTerms(taxonomy);
	const found = terms.find((t) => (match.slug && t.slug === match.slug) || (match.label && t.label === match.label));
	if (found) return found.id;
	if (!create) return null;
	const made = await ctx.taxonomies!.createTerm!(taxonomy, create);
	return made.id;
}

export interface RunResult {
	at: string;
	added: number;
	feeds: Array<{ url: string; title?: string; items?: number; added?: number; error?: string }>;
}

export async function runImport(ctx: PluginContext, config: FeedImportConfig): Promise<RunResult> {
	const result: RunResult = { at: new Date().toISOString(), added: 0, feeds: [] };
	const seen = await loadSeen(ctx);
	const categoryId = await termId(ctx, "category", { slug: config.category });
	const max = config.maxPerFeed ?? 30;

	for (const url of config.feeds) {
		const report: RunResult["feeds"][number] = { url };
		result.feeds.push(report);
		let feed: Feed;
		try {
			feed = await fetchFeed(ctx, url);
		} catch (e) {
			report.error = e instanceof Error ? e.message : String(e);
			ctx.log.warn(`[feed-import] ${url}: ${report.error}`);
			continue;
		}
		report.title = feed.title;
		report.items = feed.items.length;
		report.added = 0;
		// 古い順に追加（新着一覧で新しいものが上に来るように）
		const fresh = feed.items.filter((i) => !seen.has(normalizeLink(i.link))).reverse().slice(-max);
		if (fresh.length === 0) continue;
		let tagId: string | null = null;
		if (feed.title) {
			try {
				tagId = await termId(ctx, "tag", { label: feed.title }, { label: feed.title, slug: `feed-${new URL(url).hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-")}` });
			} catch (e) {
				ctx.log.warn(`[feed-import] tag for ${url}: ${e instanceof Error ? e.message : e}`);
			}
		}
		for (const item of fresh) {
			try {
				const data: Record<string, unknown> = { title: item.title, content: buildContent(item.link) };
				if (item.image) data.featured_image = { provider: "external", id: item.image, src: item.image, alt: item.title };
				const created = await ctx.content.create!("posts", data);
				await setSlug(created.id, await nextNumber());
				if (categoryId) await ctx.taxonomies!.addEntryTerms!("posts", created.id, "category", [categoryId]);
				if (tagId) await ctx.taxonomies!.addEntryTerms!("posts", created.id, "tag", [tagId]);
				const v = await ctx.content.getVersioned!("posts", created.id);
				if (v) await ctx.content.publish!("posts", created.id, { _rev: v._rev });
				seen.add(normalizeLink(item.link));
				report.added++;
				result.added++;
			} catch (e) {
				ctx.log.warn(`[feed-import] ${item.link}: ${e instanceof Error ? e.message : e}`);
			}
		}
		await ctx.kv.set(SEEN_KEY, [...seen]);
	}
	await ctx.kv.set(LAST_KEY, result);
	ctx.log.info(`[feed-import] added ${result.added}`);
	return result;
}

// ===== リンク切れの確認（リンク先がなくなった物件の記事をゴミ箱へ） =====
// - リンク先が 404（見つからない）・410（削除済み）→ すぐゴミ箱へ
// - つながらない（サイトが消えた・住所が引けない）→ 3日続いたらゴミ箱へ（一時的な不調では消さない）
// - それ以外（表示できる・403・500 など）は残す
// ゴミ箱に入った記事は、管理画面のゴミ箱から元に戻せる
const LC_CURSOR = "lc:cursor";
const LC_FAILS = "lc:fails";
const LC_LOG = "lc:log";
const LC_DONE = "lc:doneDate"; // 一回りし終えた日（日本時間）
const UA = "Mozilla/5.0 (compatible; apart.faq-ishigaki.com link checker)";

type LinkState = "ok" | "dead" | "unreachable";
async function checkLink(ctx: PluginContext, url: string): Promise<LinkState> {
	const doFetch = ctx.http ? ctx.http.fetch.bind(ctx.http) : fetch;
	try {
		const res = await doFetch(url, { method: "GET", redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
		try {
			await res.body?.cancel();
		} catch {}
		if (res.status === 404 || res.status === 410) return "dead";
		return "ok";
	} catch {
		return "unreachable";
	}
}
function firstLink(content: unknown): string | null {
	const links: string[] = [];
	linksIn(content, links);
	return links.find((l) => /^https?:/i.test(l)) ?? null;
}

export interface LinkCheckResult {
	at: string;
	checked: number;
	trashed: Array<{ id: string; title: string; link: string; reason: string }>;
	done: boolean; // 記事全体を一回りしたか
}

export async function runLinkCheck(ctx: PluginContext, config: FeedImportConfig, limit?: number): Promise<LinkCheckResult> {
	const started = Date.now();
	const batch = limit ?? config.linkCheckBatch ?? 150;
	const result: LinkCheckResult = { at: new Date().toISOString(), checked: 0, trashed: [], done: false };
	const fails = (await ctx.kv.get<Record<string, number>>(LC_FAILS)) ?? {};
	let cursor = (await ctx.kv.get<string>(LC_CURSOR)) ?? undefined;
	const queue: Array<{ id: string; title: string; link: string }> = [];
	while (queue.length < batch) {
		const page = await ctx.content.list("posts", { limit: 50, cursor });
		for (const item of page.items) {
			const link = firstLink(item.data?.content);
			if (link) queue.push({ id: item.id, title: String(item.data?.title ?? ""), link });
		}
		if (!page.hasMore || !page.cursor) {
			cursor = undefined;
			result.done = true;
			break;
		}
		cursor = page.cursor;
	}
	// 同時に5件ずつ確認（相手のサイトに負担をかけすぎない）
	for (let i = 0; i < queue.length; i += 5) {
		if (Date.now() - started > 240_000) {
			result.done = false;
			break;
		}
		await Promise.all(
			queue.slice(i, i + 5).map(async (q) => {
				const state = await checkLink(ctx, q.link);
				result.checked++;
				const k = normalizeLink(q.link);
				let reason = "";
				if (state === "dead") reason = "リンク先が見つからない（404/410）";
				else if (state === "unreachable") {
					fails[k] = (fails[k] ?? 0) + 1;
					if (fails[k] >= 3) reason = "リンク先に3日続けてつながらない";
				} else delete fails[k];
				if (!reason) return;
				try {
					if (await ctx.content.delete!("posts", q.id)) {
						delete fails[k];
						result.trashed.push({ ...q, reason });
					}
				} catch (e) {
					ctx.log.warn(`[feed-import] trash ${q.id}: ${e instanceof Error ? e.message : e}`);
				}
			}),
		);
	}
	await ctx.kv.set(LC_FAILS, fails);
	if (cursor) await ctx.kv.set(LC_CURSOR, cursor);
	else await ctx.kv.delete(LC_CURSOR);
	// ゴミ箱に入れた記事の記録（新しい順に500件まで）
	if (result.trashed.length) {
		const log = (await ctx.kv.get<LinkCheckResult["trashed"]>(LC_LOG)) ?? [];
		await ctx.kv.set(LC_LOG, [...result.trashed.map((t) => ({ ...t, at: result.at })), ...log].slice(0, 500));
	}
	ctx.log.info(`[feed-import] link check: ${result.checked} checked, ${result.trashed.length} trashed`);
	return result;
}

// ===== フィードを探す（ほかの不動産業者のサイトに RSS があるか調べる） =====
const CANDIDATE_SITES = [
	"https://itomax.jp/", "http://toubaru-kenzai.com/", "http://nakakikaku.net/", "https://www.daio-h.jp/",
	"http://www.daio-yaeyama.jp/", "http://www.tyurasima.fudou-san.jp/", "http://www.nikai-shoji.com/", "http://hara-syouzi.com/",
	"https://www.nanseihudousan.jp/", "https://i-island-f.jp/", "http://ishigaki-kariyushi.com/", "http://resort-in.jp/",
	"https://eehome.jp/", "https://tm-more.com/", "http://www.e-imhome.com/", "http://sanhousyouji.com/",
	"http://www.yaeyama-ishigaki.co.jp/", "http://www.grand-fill.jp/", "http://808080.info/ty/index.asp", "http://www.mensole-iju.com/",
	"https://www.able.co.jp/okinawa/area/47207/list/",
];
const FEED_PATHS = ["feed/", "?feed=rss2", "rss/", "rss.xml", "feed.xml", "atom.xml", "index.xml", "index.rdf", "data.cgi?mode=rss"];

async function probeSite(ctx: PluginContext, site: string) {
	const doFetch = ctx.http ? ctx.http.fetch.bind(ctx.http) : fetch;
	const out: { site: string; reachable: boolean; feeds: Array<{ url: string; title: string; items: number; latest: string[] }> } = { site, reachable: false, feeds: [] };
	const candidates = new Set<string>();
	try {
		const res = await doFetch(site, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
		out.reachable = res.ok;
		const html = await res.text();
		for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
			if (/type=["']application\/(rss|atom|rdf)\+xml["']/i.test(m[0])) {
				const href = attr(m[0], "href");
				if (href) candidates.add(new URL(href, res.url || site).toString());
			}
		}
	} catch {}
	const base = site.replace(/[^/]*$/, "");
	for (const p of FEED_PATHS) candidates.add(new URL(p, base).toString());
	// 候補をまとめて同時に（1つ8秒まで）
	const feeds = await Promise.all([...candidates].map((url) => fetchFeed(ctx, url, 8000).then((feed) => ({ url, feed }), () => null)));
	for (const r of feeds) {
		if (!r || !r.feed.items.length) continue;
		const { url, feed } = r;
		if (!out.feeds.some((f) => f.title === feed.title && f.items === feed.items.length)) {
			out.feeds.push({ url, title: feed.title, items: feed.items.length, latest: feed.items.slice(0, 3).map((i) => i.title) });
		}
	}
	return out;
}

async function ensureSchedules(ctx: PluginContext, config: FeedImportConfig): Promise<void> {
	if (!ctx.cron) return;
	for (const [i, schedule] of config.schedules.entries()) await ctx.cron.schedule(`crawl-${i}`, { schedule });
	for (const [i, schedule] of (config.linkCheckSchedules ?? []).entries()) await ctx.cron.schedule(`linkcheck-${i}`, { schedule });
}

export function createPlugin(config: FeedImportConfig): ResolvedPlugin {
	return definePlugin({
		id: ID,
		version: "1.0.0",
		capabilities: ["content:write", "content:publish", "taxonomies:write", "network:request:unrestricted"],
		hooks: {
			"plugin:activate": async (_event, ctx) => {
				await ensureSchedules(ctx, config);
			},
			cron: {
				timeout: 300_000,
				handler: async (event, ctx) => {
					if (!event.name.startsWith("crawl-") && !event.name.startsWith("linkcheck-")) return;
					// WordPress からの取り込みが終わる前に動くと同じ物件が二重になるので、
					// 最初の1回は管理者が手動（POST …/feed-import/run）で動かしてから自動にする
					if (!(await ctx.kv.get(SEEN_KEY))) {
						ctx.log.info("[feed-import] まだ手動で1回も動かしていないので、自動の巡回・リンク確認は休み");
						return;
					}
					if (event.name.startsWith("linkcheck-")) {
						// 1日に一回りしたら、その日はもう確認しない（「3日続けて」を正しく数えるため）
						const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
						if ((await ctx.kv.get<string>(LC_DONE)) === today) return;
						const r = await runLinkCheck(ctx, config);
						if (r.done) await ctx.kv.set(LC_DONE, today);
					} else await runImport(ctx, config);
				},
			},
		},
		routes: {
			// 今すぐ巡回（管理者だけ）
			run: {
				handler: async (ctx) => {
					await ensureSchedules(ctx, config);
					return await runImport(ctx, config);
				},
			},
			// リンク切れの確認を今すぐ（管理者だけ）。?limit=件数。続きは次の呼び出しで（done: true で一回り）
			linkcheck: {
				handler: async (ctx) => {
					await ensureSchedules(ctx, config);
					const limit = Number(new URL(ctx.request.url).searchParams.get("limit")) || undefined;
					return await runLinkCheck(ctx, config, limit);
				},
			},
			// ほかの業者のサイトにフィードがあるか調べる（?site=URL で1つだけ。なければ候補を全部）
			probe: {
				handler: async (ctx) => {
					const one = new URL(ctx.request.url).searchParams.get("site");
					if (!one) return { sites: CANDIDATE_SITES }; // 候補の一覧（1社ずつ ?site= で調べる。まとめてだと時間切れになる）
					const sites = [one];
					const results = await Promise.all(sites.map((site) => probeSite(ctx, site)));
					return { found: results.filter((r) => r.feeds.length), notFound: results.filter((r) => !r.feeds.length).map((r) => ({ site: r.site, reachable: r.reachable })) };
				},
			},
			// 最後の巡回結果、取り込み済みの件数、リンク切れでゴミ箱に入れた記事
			status: {
				handler: async (ctx) => {
					const seen = (await ctx.kv.get<string[]>(SEEN_KEY)) ?? [];
					const trashed = (await ctx.kv.get<unknown[]>(LC_LOG)) ?? [];
					return {
						lastRun: await ctx.kv.get(LAST_KEY),
						seen: seen.length,
						schedules: config.schedules,
						linkCheckSchedules: config.linkCheckSchedules ?? [],
						feeds: config.feeds,
						trashedCount: trashed.length,
						trashedRecent: trashed.slice(0, 50),
					};
				},
			},
		},
	});
}
