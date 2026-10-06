/**
 * Pawchive creator archive source.
 *
 * Pawchive is not a conventional manga site: creators are the "series" and
 * posts are their chapters. The existing source contract maps nicely to that
 * model while keeping every post attachment available to the reader.
 */
import axios from "axios";
import type {
  MangaSource, ListOptions, MangaListResponse, MangaDetail,
  DetailOptions, ChapterListResponse, PageListResponse,
  MangaSummary, ChapterSummary, PageInfo,
} from "./types.js";

const API = "https://pawchive.pw/api/v1";
const FILES = "https://file.pawchive.pw/data";
const THUMBS = "https://img.pawchive.pw/thumbnail/data";
const SOURCE_ICON = "/public/source-icons/all.pawchive.svg";
const PAGE_SIZE = 24;

type Creator = {
  id: string | number;
  name?: string;
  service?: string;
  indexed?: number;
  updated?: number;
  favorited?: number;
};

type MediaFile = { name?: string; path?: string; preview_only?: boolean };
type Post = {
  id: string | number;
  user?: string | number;
  service?: string;
  title?: string;
  substring?: string;
  content?: string;
  published?: string;
  added?: string;
  file?: MediaFile;
  attachments?: MediaFile[];
};

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|mkv|avi|m4v)$/i;

function request<T>(path: string, params?: Record<string, unknown>) {
  return axios.get<T>(`${API}${path}`, {
    params,
    headers: { Accept: "application/json", "User-Agent": "ComixHub/1.0" },
    timeout: 30_000,
  }).then(r => r.data);
}

function idFor(service: string, user: string | number) {
  return Buffer.from(JSON.stringify({ service, user: String(user) })).toString("base64url");
}

function decodeCreatorId(id: string): { service: string; user: string } {
  try {
    const value = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
    if (value?.service && value?.user) return { service: String(value.service), user: String(value.user) };
  } catch { /* invalid IDs are reported by the source route */ }
  throw new Error("Invalid Pawchive creator ID");
}

function postId(post: Post) {
  return Buffer.from(JSON.stringify({
    service: String(post.service ?? ""),
    user: String(post.user ?? ""),
    post: String(post.id),
  })).toString("base64url");
}

function decodePostId(id: string) {
  try {
    const value = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
    if (value?.service && value?.user && value?.post) return {
      service: String(value.service), user: String(value.user), post: String(value.post),
    };
  } catch { /* invalid IDs are reported by the source route */ }
  throw new Error("Invalid Pawchive post ID");
}

function fileUrl(file: MediaFile | undefined): string | null {
  if (!file?.path) return null;
  if (/^https?:\/\//i.test(file.path)) return file.path;
  if (file.preview_only && IMAGE_EXT.test(file.name ?? file.path)) return thumbnailUrl(file);
  return `${FILES}${file.path}${file.name ? `?f=${encodeURIComponent(file.name)}` : ""}`;
}

function thumbnailUrl(file: MediaFile | undefined): string {
  if (!file?.path) return SOURCE_ICON;
  if (/^https?:\/\//i.test(file.path)) return file.path;
  return `${THUMBS}${file.path}`;
}

function creatorSummary(creator: Creator, thumbnail = SOURCE_ICON): MangaSummary {
  const service = String(creator.service ?? "unknown");
  const user = String(creator.id);
  return {
    id: idFor(service, user),
    title: String(creator.name ?? `${service} creator ${user}`),
    thumbnail,
    type: `Creator · ${service}`,
    isNsfw: false,
  };
}

async function creatorSummaries(items: Creator[]): Promise<MangaSummary[]> {
  return Promise.all(items.map(async creator => {
    const service = String(creator.service ?? "unknown");
    const user = String(creator.id);
    try {
      const posts = await creatorPosts(service, user);
      const firstImage = posts
        .flatMap(post => [post.file, ...(post.attachments ?? [])])
        .find(file => !!file?.path && IMAGE_EXT.test(file.name ?? file.path ?? ""));
      return creatorSummary(creator, thumbnailUrl(firstImage));
    } catch {
      return creatorSummary(creator);
    }
  }));
}

function postDate(post: Post): number {
  const raw = post.published ?? post.added;
  const time = raw ? Date.parse(raw) : 0;
  return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
}

async function creators(): Promise<Creator[]> {
  const data = await request<Creator[]>("/creators");
  return Array.isArray(data) ? data : [];
}

function filterByTags(items: Creator[], tagIds?: string[]): Creator[] {
  if (!tagIds?.length) return items;
  const services = new Set(tagIds.filter(tag => tag.startsWith("service:")).map(tag => tag.slice(8)));
  return services.size ? items.filter(creator => services.has(String(creator.service ?? "unknown"))) : items;
}

async function creatorPosts(service: string, user: string): Promise<Post[]> {
  const data = await request<Post[]>(`/${encodeURIComponent(service)}/user/${encodeURIComponent(user)}`);
  return Array.isArray(data) ? data : [];
}

async function onePost(service: string, user: string, post: string): Promise<Post> {
  return request<Post>(
    `/${encodeURIComponent(service)}/user/${encodeURIComponent(user)}/post/${encodeURIComponent(post)}`,
  );
}

function pageMedia(post: Post): PageInfo[] {
  const files = [post.file, ...(post.attachments ?? [])]
    .filter((f): f is MediaFile => !!f?.path && MEDIA_EXT.test(f.name ?? f.path ?? ""));
  return files.map((file, index) => ({ index, url: fileUrl(file)! }));
}

export const PawchiveSource: MangaSource = {
  id: "all.pawchive",
  name: "Pawchive",
  lang: "all",
  isNsfw: false,
  imageReferer: "https://pawchive.pw/",

  async popular(opts: ListOptions): Promise<MangaListResponse> {
    const all = filterByTags(await creators(), opts.tagIds)
      .sort((a, b) => Number(b.favorited ?? 0) - Number(a.favorited ?? 0));
    const start = ((opts.page ?? 1) - 1) * PAGE_SIZE;
    return {
      items: await creatorSummaries(all.slice(start, start + PAGE_SIZE)),
      page: opts.page ?? 1,
      hasNextPage: start + PAGE_SIZE < all.length,
    };
  },

  async latest(opts: ListOptions): Promise<MangaListResponse> {
    const all = filterByTags(await creators(), opts.tagIds)
      .sort((a, b) => Number(b.updated ?? 0) - Number(a.updated ?? 0));
    const start = ((opts.page ?? 1) - 1) * PAGE_SIZE;
    return {
      items: await creatorSummaries(all.slice(start, start + PAGE_SIZE)),
      page: opts.page ?? 1,
      hasNextPage: start + PAGE_SIZE < all.length,
    };
  },

  async search(query: string, opts: ListOptions): Promise<MangaListResponse> {
    const needle = query.trim().toLowerCase();
    const all = filterByTags(await creators(), opts.tagIds).filter(c =>
      !needle || `${c.name ?? ""} ${c.service ?? ""} ${c.id}`.toLowerCase().includes(needle),
    );
    const start = ((opts.page ?? 1) - 1) * PAGE_SIZE;
    return {
      items: await creatorSummaries(all.slice(start, start + PAGE_SIZE)),
      page: opts.page ?? 1,
      hasNextPage: start + PAGE_SIZE < all.length,
    };
  },

  async details(id: string, _opts: DetailOptions): Promise<MangaDetail> {
    const { service, user } = decodeCreatorId(id);
    const profile = await request<Creator>(`/${encodeURIComponent(service)}/user/${encodeURIComponent(user)}/profile`);
    const posts = await creatorPosts(service, user);
    const firstMedia = posts.flatMap(p => [p.file, ...(p.attachments ?? [])]).find(f => !!f?.path && IMAGE_EXT.test(f.name ?? f.path ?? ""));
    return {
      id,
      title: String(profile?.name ?? posts[0]?.user ?? user),
      author: `Pawchive · ${service}`,
      artist: "",
      synopsis: "Creator archive on Pawchive. Posts may contain images, GIFs, videos, and other attachments.",
      altTitles: [],
      status: "Ongoing",
      type: "Creator gallery",
      isNsfw: false,
      rating: 0,
      thumbnail: thumbnailUrl(firstMedia),
      genres: [],
      score: "",
      scorePosition: "none",
    };
  },

  async chapters(mangaId: string, _dedupe: boolean): Promise<ChapterListResponse> {
    const { service, user } = decodeCreatorId(mangaId);
    const posts = await creatorPosts(service, user);
    return {
      items: posts.map((post, index): ChapterSummary => ({
        id: postId({ ...post, service, user }),
        number: posts.length - index,
        title: String(post.title ?? `Post ${posts.length - index}`),
        scanlator: service,
        date: postDate(post),
        thumbnail: thumbnailUrl(
          [post.file, ...(post.attachments ?? [])].find(f =>
            !!f?.path && IMAGE_EXT.test(f.name ?? f.path ?? ""),
          ),
        ),
        mediaType: (() => {
          const media = [post.file, ...(post.attachments ?? [])]
            .filter((f): f is MediaFile => !!f?.path && MEDIA_EXT.test(f.name ?? f.path ?? ""));
          const hasImage = media.some(f => IMAGE_EXT.test(f.name ?? f.path ?? ""));
          const hasVideo = media.some(f => VIDEO_EXT.test(f.name ?? f.path ?? ""));
          return hasImage && hasVideo ? "mixed" : hasVideo ? "video" : "image";
        })(),
        attachmentCount: [post.file, ...(post.attachments ?? [])]
          .filter(f => !!f?.path && MEDIA_EXT.test(f.name ?? f.path ?? "")).length,
      })),
    };
  },

  async pages(chapterId: string): Promise<PageListResponse> {
    const { service, user, post } = decodePostId(chapterId);
    const data = await onePost(service, user, post);
    const pages = pageMedia(data);
    return { chapterId, pages };
  },

  popularSorts: [
    { value: "favorites", label: "Most favorited creators" },
    { value: "updated", label: "Recently updated creators" },
  ],

  async tags() {
    const services = [...new Set((await creators()).map(creator => String(creator.service ?? "unknown")))]
      .sort((a, b) => a.localeCompare(b));
    return services.map(service => ({
      id: `service:${service}`,
      name: service.charAt(0).toUpperCase() + service.slice(1),
      group: "Platform",
    }));
  },
};

