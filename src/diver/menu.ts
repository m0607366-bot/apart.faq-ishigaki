// 上部メニュー：管理画面の「メニュー」（WordPressから取り込んだ menu1）を読み込む。
// 見つからないときは site.ts の MENU を使う。
import { getMenu } from "emdash";
import { MENU, type MenuItem } from "./site";

export const MENU_NAME = "main"; // 管理画面の「メニュー」→「メインメニュー」（取り込んだ「第一メニュー」は日本語の名前で開けないため作り直した）
const SELF = /^https?:\/\/(apart\.faq-ishigaki\.com|apart-faq-ishigaki-com\.delta-a\.workers\.dev)/i;

function normalize(url: string | undefined): string {
	let u = (url ?? "").trim();
	if (!u || u === "#") return "#";
	u = u.replace(SELF, "") || "/";
	// 固定ページは WordPress と同じ /slug/ の形に
	const m = u.match(/^\/pages\/([^/?#]+)\/?$/);
	if (m) u = `/${m[1]}/`;
	return u;
}

export interface NavItem extends MenuItem {
	sub?: boolean; // 3段目（例：タイメシの下のカオソーイ）
	target?: string;
}

export async function getSiteMenu(): Promise<NavItem[]> {
	try {
		const menu = await getMenu(MENU_NAME);
		if (!menu || menu.items.length === 0) return MENU;
		return menu.items.map((item) => {
			const children: NavItem[] = [];
			for (const c of item.children ?? []) {
				children.push({ label: c.label, href: normalize(c.url), target: c.target });
				for (const g of c.children ?? []) children.push({ label: g.label, href: normalize(g.url), target: g.target, sub: true });
			}
			return { label: item.label, href: normalize(item.url), target: item.target, ...(children.length ? { children } : {}) };
		});
	} catch {
		return MENU;
	}
}
