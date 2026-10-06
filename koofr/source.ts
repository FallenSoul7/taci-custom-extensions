/**
 * Koofr personal library source.
 *
 * Supports two kinds of entries in /manga/:
 *   - ZIP files  → pages extracted to local cache (browser can't read zips)
 *   - Standalone images / GIFs / videos → streamed directly from Koofr, zero local storage
 *
 * Cover strategy:
 *   - ZIP  → extract first image only, abort the rest of the download
 *   - Media file → proxy straight from Koofr's CDN
 */

import axios from "axios";
import unzipper from "unzipper";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as nodePath from "path";
import * as crypto from "crypto";
import * as os from "os";
import { logger } from "../lib/logger";
import type {
  MangaSource,
  ListOptions,
  MangaListResponse,
  MangaDetail,
  DetailOptions,
  ChapterListResponse,
  PageListResponse,
  MangaSummary,
  ChapterSummary,
  PageInfo,
} from "./types.js";

function basicAuth(): string {
  const email = process.env.KOOFR_EMAIL;
  const pass  = process.env.KOOFR_APP_PASSWORD;
  if (!email || !pass)
    throw new Error("KOOFR_EMAIL and KOOFR_APP_PASSWORD env vars are required but not set.");
  return "Basic " + Buffer.from(`${email}:${pass}`).toString("base64");
}

const KOOFR_API = "https://app.koofr.net/api/v2";

interface KoofrFile {
  name: string;
  type: "dir" | "file";
  size?: number;
  modified?: number;
  contentType?: string;
}

async function listDir(path: string): Promise<KoofrFile[]> {
  const res = await axios.get<{ files: KoofrFile[] }>(
    `${KOOFR_API}/mounts/primary/files/list`,
    { params: { path }, headers: { Authorization: basicAuth() }, timeout: 20_000 }
  );
  return res.data.files ?? [];
}

interface KoofrEntry extends KoofrFile { koofrPath: string; }

async function listAllFiles(): Promise<KoofrEntry[]> {
  const root = await listDir("/");
  const subdirs = root.filter(f => f.type === "dir");

  const results = await Promise.allSettled(
    subdirs.map(async (dir) => {
      const files = await listDir(`/${dir.name}`);
      return files
        .filter(f => f.type === "file" && isSupported(f.name))
        .map(f => ({ ...f, koofrPath: `/${dir.name}/${f.name}` }));
    })
  );

  return results.flatMap((r, i) => {
    if (r.status === "rejected") {
      logger.warn({ source: "koofr", folderIndex: i }, "Koofr folder listing failed");
      return [];
    }
    return r.value;
  });
}

const ALLOWED_MEDIA_EXTENSIONS = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|mkv|avi)$/i;

export function isProxySafe(koofrPath: string): boolean {
  if (!koofrPath.startsWith("/")) return false;
  if (koofrPath.includes("..")) return false;
  const parts = koofrPath.split("/").filter(Boolean);
  if (parts.length !== 2) return false;
  return ALLOWED_MEDIA_EXTENSIONS.test(parts[1]);
}

export async function koofrStream(koofrPath: string) {
  const res = await axios.get(`${KOOFR_API}/mounts/primary/files/get`, {
    params: { path: koofrPath },
    headers: { Authorization: basicAuth() },
    responseType: "stream",
    timeout: 60_000,
  });
  return { stream: res.data as NodeJS.ReadableStream, contentType: res.headers["content-type"] as string | undefined };
}

export async function koofrThumbnail(koofrPath: string, size = "lg") {
  const res = await axios.get(`${KOOFR_API}/mounts/primary/files/thumbnail`, {
    params: { path: koofrPath, size },
    headers: { Authorization: basicAuth() },
    responseType: "stream",
    timeout: 15_000,
  });
  return { stream: res.data as NodeJS.ReadableStream, contentType: res.headers["content-type"] as string | undefined };
}

function isZip(name: string)   { return /\.zip$/i.test(name); }
function isImage(name: string) { return /\.(jpe?g|png|gif|webp|avif)$/i.test(name); }
function isVideo(name: string) { return /\.(mp4|webm|mov|mkv|avi)$/i.test(name); }
function isMedia(name: string) { return isImage(name) || isVideo(name); }
function isSupported(name: string) { return isZip(name) || isMedia(name); }

export const CACHE_ROOT = "/tmp/koofr-cache";
const DONE_SENTINEL = ".done";

function cacheKey(filename: string): string {
  return crypto.createHash("md5").update(filename).digest("hex");
}

export async function extractCoverOnly(koofrPath: string, key: string): Promise<string | null> {
  const dir = nodePath.join(CACHE_ROOT, key);

  if (fs.existsSync(dir)) {
    const hit = fs.readdirSync(dir).find(f => f.startsWith(".cover."));
    if (hit) return nodePath.join(dir, hit);
  }

  await fsp.mkdir(dir, { recursive: true });

  const response = await axios.get(`${KOOFR_API}/mounts/primary/files/get`, {
    params: { path: koofrPath },
    headers: { Authorization: basicAuth() },
    responseType: "stream",
    timeout: 60_000,
  });

  return new Promise((resolve, reject) => {
    let saved = false;
    const responseStream = response.data as NodeJS.ReadableStream & { destroy?: () => void };

    const parser = (responseStream as any).pipe(unzipper.Parse({ forceStream: true }));

    parser.on("entry", (entry: unzipper.Entry) => {
      if (saved) { entry.autodrain(); return; }
      const base = nodePath.basename(entry.path);
      if (entry.path.includes("__MACOSX") || !isImage(base)) { entry.autodrain(); return; }

      saved = true;
      const ext = nodePath.extname(base);
      const coverPath = nodePath.join(dir, `.cover${ext}`);
      const ws = fs.createWriteStream(coverPath);

      entry.pipe(ws);
      ws.on("finish", () => {
        if (typeof responseStream.destroy === "function") responseStream.destroy();
        resolve(coverPath);
      });
      ws.on("error", reject);
    });

    parser.on("close", () => { if (!saved) resolve(null); });
    parser.on("error", reject);
  });
}

async function extractZip(koofrPath: string, key: string): Promise<string[]> {
  const finalDir = nodePath.join(CACHE_ROOT, key);
  const sentinel = nodePath.join(finalDir, DONE_SENTINEL);

  if (fs.existsSync(sentinel)) {
    const files = (await fsp.readdir(finalDir))
      .filter(isImage)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (files.length > 0) return files;
    await fsp.rm(finalDir, { recursive: true, force: true });
  } else if (fs.existsSync(finalDir)) {
    await fsp.rm(finalDir, { recursive: true, force: true });
  }

  const tmpDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), `koofr-${key}-`));

  try {
    const response = await axios.get(`${KOOFR_API}/mounts/primary/files/get`, {
      params: { path: koofrPath },
      headers: { Authorization: basicAuth() },
      responseType: "stream",
      timeout: 120_000,
    });

    const imageFiles: string[] = [];
    const writePromises: Promise<void>[] = [];

    await new Promise<void>((resolve, reject) => {
      (response.data as any)
        .pipe(unzipper.Parse({ forceStream: true }))
        .on("entry", (entry: unzipper.Entry) => {
          const rawName = nodePath.basename(entry.path);
          if (entry.path.includes("__MACOSX") || !isImage(rawName)) { entry.autodrain(); return; }
          const outPath = nodePath.join(tmpDir, rawName);
          const ws = fs.createWriteStream(outPath);
          const p = new Promise<void>((res2, rej2) => { ws.on("finish", res2); ws.on("error", rej2); });
          entry.pipe(ws);
          writePromises.push(p);
          imageFiles.push(rawName);
        })
        .on("close", () => resolve())
        .on("error", reject);
    });

    await Promise.all(writePromises);
    await fsp.writeFile(nodePath.join(tmpDir, DONE_SENTINEL), "");
    await fsp.mkdir(CACHE_ROOT, { recursive: true });
    await fsp.rename(tmpDir, finalDir);

    return imageFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

function encId(koofrPath: string): string { return Buffer.from(koofrPath).toString("base64url"); }
function decId(id: string): string { return Buffer.from(id, "base64url").toString("utf-8"); }

function fileTitle(koofrPath: string): string {
  const base = nodePath.basename(koofrPath);
  try { return decodeURIComponent(base).replace(/\.(zip|mp4|webm|mov|mkv|avi|jpe?g|png|gif|webp|avif)$/i, ""); }
  catch { return base.replace(/\.[^.]+$/, ""); }
}

function coverUrl(koofrPath: string): string {
  const name = nodePath.basename(koofrPath);
  if (isZip(name)) return `/public/koofr-zip-cover.png`;
  if (isVideo(name)) return `/public/koofr-video-cover.svg`;
  return `/api/koofr/proxy?path=${encodeURIComponent(koofrPath)}`;
}

function proxyUrl(koofrPath: string): string {
  return `/api/koofr/proxy?path=${encodeURIComponent(koofrPath)}`;
}

const PAGE_SIZE = 24;

function buildList(entries: KoofrEntry[], page: number): MangaListResponse {
  const start = (page - 1) * PAGE_SIZE;
  const slice = entries.slice(start, start + PAGE_SIZE);
  const items: MangaSummary[] = slice.map(f => ({
    id: encId(f.koofrPath),
    title: fileTitle(f.koofrPath),
    thumbnail: coverUrl(f.koofrPath),
    type: "Manga",
    isNsfw: false,
  }));
  return { items, page, hasNextPage: start + PAGE_SIZE < entries.length };
}

export const KoofrSource: MangaSource = {
  id: "local.koofr",
  name: "K-Cafe",
  lang: "all",
  isNsfw: false,

  async popular(opts: ListOptions): Promise<MangaListResponse> {
    return buildList(await listAllFiles(), opts.page ?? 1);
  },

  async latest(opts: ListOptions): Promise<MangaListResponse> {
    const files = (await listAllFiles()).sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
    return buildList(files, opts.page ?? 1);
  },

  async search(query: string, opts: ListOptions): Promise<MangaListResponse> {
    const q = query.toLowerCase();
    const files = (await listAllFiles()).filter(f => fileTitle(f.koofrPath).toLowerCase().includes(q));
    return buildList(files, opts.page ?? 1);
  },

  async details(id: string, _opts: DetailOptions): Promise<MangaDetail> {
    const koofrPath = decId(id);
    return {
      id,
      title: fileTitle(koofrPath),
      author: "", artist: "", synopsis: "", altTitles: [],
      status: "Unknown", type: "Manga", isNsfw: false,
      rating: 0, thumbnail: coverUrl(koofrPath),
      genres: [], score: "", scorePosition: "none",
    };
  },

  async chapters(mangaId: string, _dedupe: boolean): Promise<ChapterListResponse> {
    return {
      items: [{
        id: mangaId,
        number: 1,
        title: "Chapter 1",
        scanlator: "Koofr",
        date: Math.floor(Date.now() / 1000),
      }],
    };
  },

  async pages(chapterId: string): Promise<PageListResponse> {
    const koofrPath = decId(chapterId);
    const name = nodePath.basename(koofrPath);

    if (isZip(name)) {
      const key = cacheKey(koofrPath);
      const imageFiles = await extractZip(koofrPath, key);
      const pages: PageInfo[] = imageFiles.map((imgName, i) => ({
        index: i,
        url: `/api/koofr/file?dir=${key}&file=${encodeURIComponent(imgName)}`,
      }));
      return { chapterId, pages };
    }

    return {
      chapterId,
      pages: [{ index: 0, url: proxyUrl(koofrPath) }],
    };
  },
};

export async function getKoofrCover(_encodedId: string): Promise<string | null> {
  return null;
}

