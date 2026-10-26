// YouTubeのURLから動画IDと開始秒を取り出す（youtu.be / watch?v= / shorts / live / embed）
export function youtubeId(raw: string): { id: string; start?: number } | null {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	const host = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
	let id: string | null = null;
	if (host === "youtu.be") id = u.pathname.split("/")[1] ?? null;
	else if (host === "youtube.com" || host === "youtube-nocookie.com") {
		if (u.pathname === "/watch") id = u.searchParams.get("v");
		else {
			const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/);
			if (m) id = m[1];
		}
	}
	if (!id || !/^[\w-]{6,20}$/.test(id)) return null;
	const t = u.searchParams.get("t") ?? u.searchParams.get("start");
	let start: number | undefined;
	if (t) {
		const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
		if (m) start = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) || undefined;
	}
	return { id, start };
}
