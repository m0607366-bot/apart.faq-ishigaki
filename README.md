# 石垣島マンション・アパート一覧（apart.faq-ishigaki.com）

WordPress から EmDash（Cloudflare Workers ＋ D1 ＋ R2）へ移したサイト。blog.delta-a.net の仕組みを流用（117fx 版で入れた noindex・サイドバーなし・広告なしの切り替えも site.ts で使える）。

- トップは「先頭に固定表示」の記事＋新着一覧（site.ts の stickyPostId）。
- メールでログイン（送信元 noreply@mail.delta-a.net）。
- `npm run deploy` … 公開
