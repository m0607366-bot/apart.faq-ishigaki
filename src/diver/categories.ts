// カテゴリーの親子関係を、管理画面（Categories）の設定から組み立てる
import { getTaxonomyTerms } from "emdash";

export interface CatNode {
	id: string;
	slug: string;
	label: string;
	count: number;
	description?: string;
	parent?: CatNode;
	children: CatNode[];
}

export interface Categories {
	roots: CatNode[];
	bySlug: Map<string, CatNode>;
	/** /category/親/子/ 形式のURL（WordPressと同じ） */
	url(slug: string): string;
	/** 親→子の順のパンくず */
	trail(slug: string): CatNode[];
	/** そのカテゴリーと子孫カテゴリーのslug（親の一覧に子の記事も出すため） */
	descendants(slug: string): string[];
}

export async function getCategories(): Promise<Categories> {
	const terms = (await getTaxonomyTerms("category")) as any[];
	const bySlug = new Map<string, CatNode>();
	const byId = new Map<string, CatNode>();
	const visit = (list: any[]) => {
		for (const t of list) {
			const node: CatNode = { id: t.id, slug: t.slug, label: t.label, count: t.count ?? 0, description: t.description, children: [] };
			bySlug.set(t.slug, node);
			byId.set(t.id, node);
			if (Array.isArray(t.children)) visit(t.children);
		}
	};
	visit(terms);
	// parentId から親子をつなぐ（ツリーでもフラットでも同じ結果になるように）
	const flat: any[] = [];
	const collect = (list: any[]) => list.forEach((t) => (flat.push(t), Array.isArray(t.children) && collect(t.children)));
	collect(terms);
	const roots: CatNode[] = [];
	for (const t of flat) {
		const node = byId.get(t.id)!;
		const parent = t.parentId ? byId.get(t.parentId) : undefined;
		if (parent && parent !== node) {
			node.parent = parent;
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}
	// 並び順は管理画面（Categories）の「上に移動／下に移動」の順番をそのまま使う

	const trail = (slug: string): CatNode[] => {
		const out: CatNode[] = [];
		let n = bySlug.get(slug);
		const seen = new Set<string>();
		while (n && !seen.has(n.slug)) {
			seen.add(n.slug);
			out.unshift(n);
			n = n.parent;
		}
		return out;
	};
	const url = (slug: string) => {
		const t = trail(slug);
		return t.length ? `/category/${t.map((n) => encodeURIComponent(n.slug)).join("/")}/` : `/category/${encodeURIComponent(slug)}/`;
	};
	const descendants = (slug: string): string[] => {
		const out: string[] = [];
		const walk = (n?: CatNode) => {
			if (!n || out.includes(n.slug)) return;
			out.push(n.slug);
			n.children.forEach(walk);
		};
		walk(bySlug.get(slug));
		return out.length ? out : [slug];
	};
	return { roots, bySlug, url, trail, descendants };
}
