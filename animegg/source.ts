import axios from "axios";
import * as cheerio from "cheerio";
import type { ChapterListResponse, DetailOptions, ListOptions, MangaDetail, MangaListResponse, MangaSource, PageListResponse, VideoTrack } from "./types";

const BASE = "https://www.animegg.org";
const ANIMEGG_ICON = "/public/source-icons/en.animegg.svg";
const BROWSE_FALLBACK = [["one-piece", "One Piece"], ["naruto-shippuden", "Naruto Shippuden"], ["detectiveconan", "Detective Conan"], ["bleach", "Bleach"]] as const;
const ANIME_GENRES = ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mystery", "Romance", "Sci-Fi", "Sports", "Thriller", "Supernatural", "Historical", "School", "Shounen", "Shoujo", "Music", "Military", "Psychological"];
const HTML_REQUEST_TIMEOUT_MS = 40_000;
const http = axios.create({ timeout: HTML_REQUEST_TIMEOUT_MS, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36", Accept: "text/html,application/json;q=0.9,*/*;q=0.8", Referer: `${BASE}/` } });
const HTML_CACHE_TTL_MS = 15 * 60 * 1000;
const HTML_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const htmlCache = new Map<string, { expiresAt: number; data: string }>();
const htmlInFlight = new Map<string, Promise<string>>();
const JSON_CACHE_TTL_MS = 2 * 60 * 1000;
const jsonCache = new Map<string, { expiresAt: number; data: unknown }>();
const jsonInFlight = new Map<string, Promise<unknown>>();
const MAX_CACHE_ENTRIES = 250;

function trimCache<T>(cache: Map<string, T>): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function getHtml(url: string, timeout: number): Promise<string> {
  const cached = htmlCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const pending = htmlInFlight.get(url);
  if (pending) return pending;
  const request = http.get<string>(url, { timeout }).then(response => {
    const html = response.data;
    const head = html.slice(0, 20000).toLowerCase();
    if (/just a moment|cf-chl-|challenge-platform|attention required|enable javascript and cookies|cloudflare ray id/.test(head)) {
      throw new Error("AnimeGG returned a protection page");
    }
    htmlCache.set(url, { expiresAt: Date.now() + HTML_CACHE_TTL_MS, data: html });
    trimCache(htmlCache);
    return html;
  }).catch(error => {
    if (cached && Date.now() - cached.expiresAt < HTML_STALE_TTL_MS) return cached.data;
    throw error;
  }).finally(() => htmlInFlight.delete(url));
  htmlInFlight.set(url, request);
  return request;
}

async function getJson<T>(url: string, timeout: number): Promise<T> {
  const cached = jsonCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.data as T;
  const pending = jsonInFlight.get(url);
  if (pending) return pending as Promise<T>;
  const request = http.get<T>(url, { timeout }).then(response => {
    jsonCache.set(url, { expiresAt: Date.now() + JSON_CACHE_TTL_MS, data: response.data });
    trimCache(jsonCache);
    return response.data;
  }).finally(() => jsonInFlight.delete(url));
  jsonInFlight.set(url, request as Promise<unknown>);
  return request;
}

function absolute(value: string): string {
  if (value.startsWith("//")) return `https:${value}`;
  return value.startsWith("http") ? value : `${BASE}${value.startsWith("/") ? "" : "/"}${value}`;
}
function slugFromId(id: string): string { return decodeURIComponent(id).replace(/^\/series\//, "").replace(/\/$/, ""); }

function toSummary($: cheerio.CheerioAPI, root: any) {
  const link = $(root).find("a[href^='/series/']").first().length
    ? $(root).find("a[href^='/series/']").first()
    : $(root).closest("a[href^='/series/']").first();
  const href = link.attr("href") || "";
  const title = $(root).find(".rightpop a[href^='/series/'], .releaseLink, h2").first().text().trim() || link.text().trim();
  if (!href || !title) return null;
  const thumbnail = $(root).find("img").first().attr("src") || $(root).find("img").first().attr("data-src") || "";
  return { id: slugFromId(href), title, thumbnail: absolute(thumbnail), type: "Anime", isNsfw: false, mediaType: "anime" as const };
}

function parseListing(document: cheerio.CheerioAPI, page: number): MangaListResponse {
  const $ = document;
  const seen = new Set<string>();
  const items = $("li.fea").toArray().flatMap((el) => {
    const item = toSummary($, el);
    if (!item || seen.has(item.id)) return [];
    seen.add(item.id);
    return [item];
  });
  return { items, page, hasNextPage: $("ul.pagination a").toArray().some(el => $(el).text().trim().toLowerCase() === "next") };
}

async function listing(path: string, page: number): Promise<MangaListResponse> {
  const separator = path.includes("?") ? "&" : "?";
  const html = await getHtml(`${BASE}${path}${separator}limit=25&start=${(page - 1) * 25}`, HTML_REQUEST_TIMEOUT_MS);
  return parseListing(cheerio.load(html), page);
}

function genrePath(opts: ListOptions): string | null {
  const genre = opts.tagIds?.find(Boolean);
  return genre ? `/genre/${encodeURIComponent(genre.toLowerCase())}` : null;
}

function fallbackListing(page: number): MangaListResponse {
  return { page, hasNextPage: false, items: BROWSE_FALLBACK.map(([id, title]) => ({ id, title, thumbnail: ANIMEGG_ICON, type: "Anime", isNsfw: false, mediaType: "anime" as const })) };
}

function fallbackDetail(slug: string): MangaDetail {
  const title = slug.split("-").map(word => word ? word[0].toUpperCase() + word.slice(1) : word).join(" ");
  return { id: slug, title, author: "", artist: "", synopsis: "AnimeGG is temporarily unavailable while its upstream server is protected by Cloudflare. Try again shortly.", altTitles: [], status: "Ongoing", type: "Anime", isNsfw: false, rating: 0, thumbnail: ANIMEGG_ICON, genres: [], score: "", scorePosition: "none" };
}

async function search(query: string, opts: ListOptions): Promise<MangaListResponse> {
  const genre = genrePath(opts);
  if (!query.trim() && genre) return listing(genre, opts.page).catch(() => fallbackListing(opts.page));
  if (!query.trim()) return listing("/popular-series", opts.page).catch(() => fallbackListing(opts.page));
  const searchPath = `/search/?q=${encodeURIComponent(query.trim())}&limit=25&start=${(opts.page - 1) * 25}`;
  const html = await getHtml(`${BASE}${searchPath}`, HTML_REQUEST_TIMEOUT_MS);
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const items = $(".media.searchre").toArray().flatMap(el => {
    const item = toSummary($, el);
    if (!item || seen.has(item.id)) return [];
    seen.add(item.id);
    return [item];
  });
  return { items, page: opts.page, hasNextPage: items.length > 0 };
}

async function details(id: string): Promise<MangaDetail> {
  const slug = slugFromId(id);
  let response: { data: string };
  try {
    response = { data: await getHtml(`${BASE}/series/${encodeURIComponent(slug)}`, HTML_REQUEST_TIMEOUT_MS) };
  } catch {
    return fallbackDetail(slug);
  }
  const $ = cheerio.load(response.data);
  const title = $("h1").first().text().trim() || $("title").text().replace(/^Watch\s+|\s+Episodes.*$/gi, "").trim() || slug;
  const info = $(".infoami").map((_i, el) => $(el).text().trim()).get().join(" ");
  const status = /completed|finished/i.test(info) ? "Completed" : "Ongoing";
  const thumbnail = $(".media-object").first().attr("src") || $("meta[property='og:image']").attr("content") || ANIMEGG_ICON;
  const synopsis = $(".ptext").first().text().trim();
  const alt = $(".infoami").filter((_i, el) => /Alternate Titles/i.test($(el).text())).text().replace(/^Alternate Titles:\s*/i, "").split(",").map(s => s.trim()).filter(Boolean);
  const genres = $(".tagscat a").map((_i, el) => $(el).text().trim()).get().filter(Boolean);
  return { id: slug, title, author: "", artist: "", synopsis, altTitles: alt, status, type: "Anime", isNsfw: false, rating: 0, thumbnail: absolute(thumbnail), genres, score: "", scorePosition: "none" };
}

async function chapters(id: string): Promise<ChapterListResponse> {
  const slug = slugFromId(id);
  let response: { data: string };
  try {
    response = { data: await getHtml(`${BASE}/series/${encodeURIComponent(slug)}`, HTML_REQUEST_TIMEOUT_MS) };
  } catch {
    return { items: [] };
  }
  const $ = cheerio.load(response.data);
  const items = $("ul.newmanga li").toArray().flatMap((el) => {
    const link = $(el).find("a.anm_det_pop").first();
    const href = link.attr("href") || "";
    const number = Number((href.match(/episode-(\d+)/i) || [])[1] || link.text().match(/(\d+)/)?.[1] || 0);
    if (!href || !number) return [];
    const title = $(el).find("i.anititle").first().text().trim() || `Episode ${number}`;
    return [{ id: absolute(href), number, title, scanlator: "AnimeGG", date: 0, isOfficial: true, mediaType: "video" as const }];
  });
  return { items: items.sort((a, b) => b.number - a.number) };
}

async function pages(chapterId: string): Promise<PageListResponse> {
  const episodeUrl = absolute(decodeURIComponent(chapterId));
  const response = { data: await getHtml(episodeUrl, HTML_REQUEST_TIMEOUT_MS) };
  const $ = cheerio.load(response.data);
  const tracks: VideoTrack[] = $("#videos a[data-toggle='tab']").toArray().flatMap((el) => {
    const version = ($(el).attr("data-version") || "").toLowerCase();
    const href = $(el).attr("href") || "";
    const iframe = $(".tab-pane" + href).find("iframe.video").attr("src") || "";
    if (!iframe || !version) return [];
    const isDub = version === "dubbed";
    const track = {
      id: `${version}-${$(el).attr("data-id") || iframe}`,
      label: isDub ? "English dub" : "Original Japanese audio · subtitles",
      url: absolute(iframe),
      available: true,
      audioLanguage: isDub ? "English" : "Japanese",
      subtitleLanguage: isDub ? undefined : "English",
      kind: isDub ? "dub" : "sub",
    } satisfies VideoTrack;
    return [track, ...(!isDub ? [{ id: "original-no-subtitles", label: "Original Japanese audio · no subtitles (unavailable)", url: absolute(iframe), available: false, audioLanguage: "Japanese", subtitleLanguage: undefined, kind: "original" }] : [])];
  });
  if (!tracks.length) {
    const iframe = $("iframe.video").first().attr("src");
    if (iframe) tracks.push({ id: "default", label: "Original / unavailable track details", url: absolute(iframe), kind: "original" });
  }
  if (!tracks.length) throw new Error(`AnimeGG has no playable embed for ${episodeUrl}`);
  return { chapterId, pages: [{ index: 0, url: tracks[0].url, videoTracks: tracks }] };
}

const AnimeGGSource: MangaSource = {
  id: "en.animegg", name: "AnimeGG", lang: "en", isNsfw: false,
  popular: opts => listing(genrePath(opts) || "/popular-series", opts.page).catch(() => fallbackListing(opts.page)),
  latest: opts => listing(genrePath(opts) || "/releases", opts.page).catch(() => fallbackListing(opts.page)),
  search,
  details: (id, _opts: DetailOptions) => details(id),
  chapters: id => chapters(id),
  pages,
  tags: async () => ANIME_GENRES.map(name => ({ id: name.toLowerCase(), name, group: "Genre" })),
};

export { AnimeGGSource };
export default AnimeGGSource;

