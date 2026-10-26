// 管理画面まわりの追加処理をまとめて読み込む（astro.config.mjs の emdash({ middleware: { outer } }) から）
import { sequence } from "astro:middleware";
import { onRequest as uploadResize } from "./upload-resize";
import { onRequest as postIdSlug } from "./post-id-slug";
import { onRequest as noCacheAdmin } from "./no-cache-admin";

export const onRequest = sequence(noCacheAdmin, postIdSlug, uploadResize);
