import type {
  MangaSource,
  ListOptions,
  MangaListResponse,
  MangaDetail,
  DetailOptions,
  ChapterListResponse,
  PageListResponse,
  MangaSummary,
  MangaDetailSourceTag,
} from "./types";
import { makeHttp, fetchHtml, fetchJson } from "./scraper-utils";

const BASE = "https://panda.chaika.moe";

const http = makeHttp(BASE, {
  Accept: "application/json, text/html,*/*;q=0.8",
});

interface LongArchive {
  id:         number;
  title:      string;
  title_jpn?: string;
  thumbnail:  string;
  tags:       string[];
  category:   string;
  rating:     string;
  posted:     number;
  filecount:  number;
  url:        string;
}
interface SearchResponse {
  archives:  LongArchive[];
  hasNext:   boolean;
}
interface ArchiveDetail {
  title:       string;
  title_jpn?:  string;
  tags:        string[];
  category:    string;
  rating:      number;
  posted:      number;
  filecount:   number;
  download:    string;
  uploader?:   string;
}

const API_SELF = (
  process.env["RENDER_EXTERNAL_URL"] ||
  process.env["API_BASE_URL"] ||
  "http://localhost:8080"
).replace(/\/+$/, "");

function pageProxyUrl(archiveId: number, index: number): string {
  return `${API_SELF}/api/pandachaika-page?archive=${archiveId}&index=${index}`;
}

function archiveToSummary(a: LongArchive): MangaSummary {
  const title = a.title?.trim() || a.title_jpn?.trim() || `Archive ${a.id}`;
  return {
    id:        String(a.id),
    title,
    thumbnail: a.thumbnail,
    type:      a.category || "Doujinshi",
    isNsfw:    true,
  };
}

function parseTags(tags: string[]): string[] {
  return tags
    .filter(t => !t.startsWith("artist:") && !t.startsWith("group:") && !t.startsWith("language:"))
    .map(t => {
      const colon = t.indexOf(":");
      return colon >= 0 ? t.slice(colon + 1).replace(/_/g, " ") : t;
    });
}

function parseArtist(tags: string[]): string {
  const a = tags.find(t => t.startsWith("artist:"));
  return a ? a.slice(7).replace(/_/g, " ") : "";
}

function tagGroup(tag: string): string {
  const scope = tag.split(":", 1)[0] || "other";
  return scope[0].toUpperCase() + scope.slice(1);
}

function sourceTags(tags: string[]): MangaDetailSourceTag[] {
  return tags
    .map(raw => raw.trim())
    .filter(Boolean)
    .map(raw => {
      const colon = raw.indexOf(":");
      const name = (colon >= 0 ? raw.slice(colon + 1) : raw).replace(/_/g, " ");
      return { id: raw, name, group: tagGroup(raw) };
    });
}

function searchUrl(params: Record<string, string>): string {
  const q = new URLSearchParams({ apply: "", json: "", ...params });
  return `/search/?${q}`;
}

const TAG_SCOPES = ["language", "artist", "group", "parody", "female", "male", "mixed", "other"];
const TAG_QUERY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
let cachedTags: Array<{ id: string; name: string; group: string }> | null = null;

function tagParams(o: ListOptions): Record<string, string> {
  return o.tagIds?.length ? { tags: o.tagIds.join(",") } : {};
}

export const PandaChaikaSource: MangaSource = {
  id:     "all.pandachaika",
  name:   "Panda Chaika",
  lang:   "en",
  isNsfw: true,
  imageReferer: `${BASE}/`,

  popularSorts: [
    { value: "rating",      label: "Top Rated"  },
    { value: "public_date", label: "Newest"      },
    { value: "filecount",   label: "Most Pages"  },
  ],

  async popular(o: ListOptions): Promise<MangaListResponse> {
    const sort = o.sort || "rating";
    const data = await fetchJson<SearchResponse>(http, searchUrl({ sort, page: String(o.page), ...tagParams(o) }));
    return { items: data.archives.map(archiveToSummary), page: o.page, hasNextPage: data.hasNext };
  },

  async latest(o: ListOptions): Promise<MangaListResponse> {
    const data = await fetchJson<SearchResponse>(http, searchUrl({ sort: "public_date", page: String(o.page), ...tagParams(o) }));
    return { items: data.archives.map(archiveToSummary), page: o.page, hasNextPage: data.hasNext };
  },

  async search(query: string, o: ListOptions): Promise<MangaListResponse> {
    const data = await fetchJson<SearchResponse>(
      http,
      searchUrl({ title: query.trim(), sort: "rating", page: String(o.page), ...tagParams(o) }),
    );
    return { items: data.archives.map(archiveToSummary), page: o.page, hasNextPage: data.hasNext };
  },

  async tags() {
    if (cachedTags) return cachedTags;
    const groups = await Promise.all(TAG_SCOPES.map(async scope => {
      const group = scope[0].toUpperCase() + scope.slice(1);
      const queries = [scope, ...TAG_QUERY_CHARS.map(char => `${scope}:${char}`)];
      const responses = await Promise.all(queries.map(async query => {
        try {
          return await fetchHtml(http, `/tag-autocomplete/?q=${encodeURIComponent(query)}`);
        } catch {
          return null;
        }
      }));
      const tags: Array<{ id: string; name: string; group: string }> = [];
      for (const response of responses) {
        response?.$?.("a.choice[data-value]").each((_i, el) => {
          const value = response.$(el).attr("data-value")?.trim();
          if (!value || !value.startsWith(`${scope}:`)) return;
          tags.push({ id: value, name: value.slice(scope.length + 1).replace(/_/g, " "), group });
        });
      }
      return tags;
    }));
    const seen = new Set<string>();
    cachedTags = groups.flat().filter(tag => !seen.has(tag.id) && seen.add(tag.id));
    return cachedTags;
  },

  async details(id: string, _opts: DetailOptions): Promise<MangaDetail> {
    const d = await fetchJson<ArchiveDetail>(http, `/api?archive=${id}`);
    return {
      id,
      title:         d.title,
      author:        parseArtist(d.tags),
      artist:        parseArtist(d.tags),
      synopsis:      d.uploader ? `Uploaded by ${d.uploader}` : "",
      altTitles:     d.title_jpn ? [d.title_jpn] : [],
      status:        "Completed",
      type:          d.category || "Doujinshi",
      isNsfw:        true,
      rating:        0,
      thumbnail:     `https://static.chaika.moe/media/images/thumbs/archive_${id}/thumb2.jpg`,
      genres:        parseTags(d.tags),
      score:         d.rating ? String(d.rating) : "",
      scorePosition: "top",
      sourceTags:    sourceTags(d.tags),
    };
  },

  async chapters(id: string): Promise<ChapterListResponse> {
    const d = await fetchJson<ArchiveDetail>(http, `/api?archive=${id}`);
    return {
      items: [
        {
          id,
          number:    1,
          title:     `${d.filecount} pages`,
          scanlator: d.uploader || "Panda Chaika",
          date:      d.posted,
        },
      ],
    };
  },

  async pages(chapterId: string): Promise<PageListResponse> {
    const archiveId = parseInt(chapterId, 10);
    const d = await fetchJson<ArchiveDetail>(http, `/api?archive=${archiveId}`);
    const pages = Array.from({ length: d.filecount }, (_, i) => ({
      index: i,
      url:   pageProxyUrl(archiveId, i),
    }));
    return { chapterId, pages };
  },
};

