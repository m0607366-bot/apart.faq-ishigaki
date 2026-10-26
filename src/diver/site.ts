// apart.faq-ishigaki.com（WordPress）の構成を EmDash で再現するための設定

export const SITE = {
	title: "石垣島マンション・アパート一覧",
	tagline: "石垣市内11不動産業社の最新情報を一覧で比較",
	copyright: "Copyright© 石垣島マンション・アパート一覧 All Rights Reserved.",
	timeZone: "Asia/Tokyo", // WordPress側のタイムゾーン設定に合わせる
	firstMonth: "2019-03", // アーカイブの開始月
	adsenseClient: "", // AdSense（入れると有効）
	googleTag: "", // Googleアナリティクス（入れると有効）
	cfBeaconToken: "", // Cloudflare Web Analytics（アクセス解析）のトークン
	stickyPostId: "", // トップページの先頭に固定表示する記事（取り込み後に「はじめに」の記事IDを入れる）
	thumbFromLink: true, // 写真のない記事は、リンク先（各社の物件ページ）の写真を一覧のサムネイルに使う
};

export interface MenuItem {
	label: string;
	href: string;
	children?: MenuItem[];
}

// 上部メニュー（WordPressのメニューと同じ）
export const MENU: MenuItem[] = [
	{ label: "TOP", href: "/" },
	{ label: "空き室一覧", href: "/category/excel/" },
	{ label: "一覧に表示される不動産業者", href: "/hyou/" },
	{ label: "石垣島のマンション・アパート賃貸物件を扱う業者", href: "/page-92/" },
	{ label: "石垣島での新生活に役立つサイト", href: "/page-84/" },
	{ label: "お問い合わせ", href: "/info/" },
];

// フッターのメニュー（空ならリンクなし。null にすると上部メニューと同じ項目を出す）
export const FOOTER_MENU: MenuItem[] | null = [];

// WordPressのカテゴリー階層（EmDashへの取り込みで親子関係が失われるため、ここで持つ）
export const CATEGORY_PATH: Record<string, string> = {};

export function categoryUrl(slug: string): string {
	return CATEGORY_PATH[slug] ?? `/category/${slug}/`;
}

/** 親カテゴリーの一覧には子カテゴリーの記事も含める（WordPressと同じ） */
export function categoryWithDescendants(slug: string): string[] {
	const base = categoryUrl(slug);
	return Object.entries(CATEGORY_PATH)
		.filter(([, path]) => path.startsWith(base))
		.map(([s]) => s);
}

/** 親→子の順にパンくず用のカテゴリーslugを返す */
export function categoryTrail(slug: string): string[] {
	const path = categoryUrl(slug).replace(/^\/category\//, "").replace(/\/$/, "");
	return path.split("/").filter(Boolean);
}

const dateFmt = new Intl.DateTimeFormat("ja-JP", {
	timeZone: SITE.timeZone,
	year: "numeric",
	month: "long",
	day: "numeric",
});
export function formatJaDate(d: Date | null | undefined): string {
	return d ? dateFmt.format(d) : "";
}

/** 投稿から3日以内ならNEW */
export function isNew(d: Date | null | undefined): boolean {
	return !!d && Date.now() - d.getTime() < 3 * 24 * 60 * 60 * 1000;
}

/** 本文（Portable Text）から抜粋を作る */
/** 改ページかどうか: 「改ページ」とだけ書いた段落（【改ページ】[改ページ] も可）、または WordPress と同じ <!--nextpage--> */
const PAGE_BREAK = /^(?:<!--\s*nextpage\s*-->|[【\[［]?\s*改ページ\s*[】\]］]?)$/i;
export function isPageBreak(block: any): boolean {
	if (block?._type !== "block" || !Array.isArray(block.children)) return false;
	const text = block.children.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
	return PAGE_BREAK.test(text);
}

/** 本文を改ページの位置で分ける（改ページがなければ1ページ） */
export function splitPages<T>(content: T[] | undefined | null): T[][] {
	const pages: T[][] = [[]];
	for (const block of content ?? []) {
		if (isPageBreak(block)) pages.push([]);
		else pages[pages.length - 1]!.push(block);
	}
	return pages.filter((p, i) => p.length > 0 || i === 0);
}

export function excerptOf(content: unknown, max = 90): string {
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content as Array<Record<string, unknown>>) {
		if (block?._type !== "block" || !Array.isArray(block.children) || isPageBreak(block)) continue;
		for (const span of block.children as Array<Record<string, unknown>>) {
			if (typeof span.text === "string") text += span.text;
		}
		text += " ";
		if (text.length > max * 2) break;
	}
	// apart: 物件ページへのリンクの文字は抜粋に出さない
	text = text.replace(/このサイトの記事を見る/g, " ").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** アーカイブ用の月リスト（新しい順） */
export function archiveMonths(): Array<{ y: number; m: number }> {
	const [fy, fm] = SITE.firstMonth.split("-").map(Number);
	const now = new Date(new Date().toLocaleString("en-US", { timeZone: SITE.timeZone }));
	const out: Array<{ y: number; m: number }> = [];
	let y = now.getFullYear();
	let m = now.getMonth() + 1;
	while (y > fy || (y === fy && m >= fm)) {
		out.push({ y, m });
		m--;
		if (m === 0) {
			m = 12;
			y--;
		}
	}
	return out;
}

/** /page/2/ のようなページ番号をURLの末尾から取り出す */
export function splitPaging(segments: string[]): { rest: string[]; page: number } {
	const i = segments.lastIndexOf("page");
	if (i >= 0 && i === segments.length - 2 && /^\d+$/.test(segments[i + 1])) {
		return { rest: segments.slice(0, i), page: Math.max(1, Number(segments[i + 1])) };
	}
	return { rest: segments, page: 1 };
}

export const PER_PAGE = 10;

/**
 * WordPressから取り込んだ日本語スラッグは「%e3%82%88…」の形で保存されている。
 * URLから来た文字（デコード済み）と保存形式の両方で探せるよう候補を返す。
 */
export function slugCandidates(slug: string): string[] {
	const out = new Set<string>([slug]);
	try { out.add(encodeURIComponent(slug).toLowerCase()); } catch {}
	try { out.add(decodeURIComponent(slug)); } catch {}
	return [...out];
}

/** 保存されているスラッグからWordPressと同じURLを作る */
export function slugUrl(stored: string): string {
	return `/${/%[0-9a-f]{2}/i.test(stored) ? stored : encodeURIComponent(stored)}/`;
}
