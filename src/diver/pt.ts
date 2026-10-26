// 本文（Portable Text）の表示に使う部品の差し替え
import BlockOrCard from "./BlockOrCard.astro";
import EmbedOrCard from "./EmbedOrCard.astro";
import HtmlOrCard from "./HtmlOrCard.astro";

export const ptComponents = {
	block: BlockOrCard,
	type: { embed: EmbedOrCard, htmlBlock: HtmlOrCard },
};
