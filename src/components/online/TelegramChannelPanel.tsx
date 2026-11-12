import { useEffect, useState, type FormEvent } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FileArchive,
  Images,
  Link2,
  ListChecks,
  Loader2,
  Search,
  Send,
} from "lucide-react";
import type { TelegramChannel, TelegramChapter } from "@/lib/tauri";
import { useI18n, type MessageKey } from "@/i18n";
import { formatTelegramSize } from "@/features/online/telegramGate";
import { onlineSourceAddress } from "@/lib/sourceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Props {
  channel: TelegramChannel;
  busyId: string | null;
  loadingMore: boolean;
  searching: boolean;
  onImport: (chapter: TelegramChapter) => void;
  onImportIndex: (chapter: TelegramChapter, urls: string[]) => void;
  onSearch: (query: string) => void;
  onLoadMore: () => void;
}

function kindMeta(kind: TelegramChapter["kind"]): {
  icon: typeof Images;
  key: MessageKey;
} {
  switch (kind) {
    case "telegraph":
      return { icon: Link2, key: "browser.telegram.kind.telegraph" };
    case "document":
      return { icon: FileArchive, key: "browser.telegram.kind.document" };
    case "index":
      return { icon: ListChecks, key: "browser.telegram.kind.index" };
    default:
      return { icon: Images, key: "browser.telegram.kind.photos" };
  }
}

/** Telegram 公开频道章节列表；只导入用户点击的章节。 */
export default function TelegramChannelPanel({
  channel,
  busyId,
  loadingMore,
  searching,
  onImport,
  onImportIndex,
  onSearch,
  onLoadMore,
}: Props) {
  const { t } = useI18n();
  const [term, setTerm] = useState(channel.query ?? "");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});

  // 换频道或切换搜索条件时收起目录勾选，避免旧选择悄悄带入新结果。
  useEffect(() => {
    setTerm(channel.query ?? "");
    setExpanded(new Set());
    setSelection({});
  }, [channel.channel, channel.query]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (searching) return;
    onSearch(term.trim());
  };

  const toggleExpanded = (chapter: TelegramChapter) => {
    const next = new Set(expanded);
    if (next.has(chapter.id)) {
      next.delete(chapter.id);
    } else {
      next.add(chapter.id);
      if (!(chapter.id in selection)) {
        setSelection((prev) => ({
          ...prev,
          [chapter.id]: new Set((chapter.links ?? []).map((link) => link.url)),
        }));
      }
    }
    setExpanded(next);
  };

  const selectedFor = (chapter: TelegramChapter): Set<string> =>
    selection[chapter.id] ??
    new Set((chapter.links ?? []).map((link) => link.url));

  const setChapterSelection = (chapter: TelegramChapter, next: Set<string>) => {
    setSelection((prev) => ({ ...prev, [chapter.id]: next }));
  };

  const toggleLink = (
    chapter: TelegramChapter,
    url: string,
    checked: boolean,
  ) => {
    const next = new Set(selectedFor(chapter));
    if (checked) next.add(url);
    else next.delete(url);
    setChapterSelection(chapter, next);
  };

  return (
    <section
      data-testid="telegram-channel-panel"
      aria-label={t("browser.telegram.channelTitle")}
      className="rounded-2xl border border-border bg-secondary/40 p-4"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-foreground shadow-hard-sm">
          <Send className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-bold">
              {channel.title || channel.channel}
            </h2>
            <Badge variant="secondary" className="shrink-0">
              @{channel.channel}
            </Badge>
            <Badge variant="outline" className="shrink-0">
              {t("browser.telegram.chapterCount", {
                count: channel.chapters.length,
              })}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t("browser.telegram.publicNote")}
          </p>
        </div>
      </div>

      <form
        onSubmit={submitSearch}
        data-testid="telegram-search"
        className="mt-3 flex flex-wrap items-center gap-2"
      >
        <Input
          value={term}
          onChange={(event) => setTerm(event.currentTarget.value)}
          maxLength={120}
          spellCheck={false}
          aria-label={t("browser.telegram.searchPlaceholder")}
          placeholder={t("browser.telegram.searchPlaceholder")}
          data-testid="telegram-search-input"
          className="h-9 min-w-0 flex-1 basis-40 text-xs"
        />
        <Button
          type="submit"
          variant="pill"
          size="pill-sm"
          className="shrink-0 whitespace-nowrap"
          disabled={searching || loadingMore}
          data-testid="telegram-search-submit"
        >
          {searching ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Search className="size-3.5" aria-hidden />
          )}
          {searching
            ? t("browser.telegram.searching")
            : t("browser.telegram.search")}
        </Button>
        {channel.query ? (
          <Button
            type="button"
            variant="pill"
            size="pill-sm"
            className="shrink-0 whitespace-nowrap"
            disabled={searching}
            data-testid="telegram-search-clear"
            onClick={() => {
              setTerm("");
              onSearch("");
            }}
          >
            {t("browser.telegram.searchClear")}
          </Button>
        ) : null}
      </form>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        {channel.query
          ? t("browser.telegram.searchActive", { query: channel.query })
          : t("browser.telegram.searchHint")}
      </p>

      {channel.chapters.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          {t("browser.telegram.noChapters")}
        </p>
      ) : (
        <ScrollArea className="mt-3 max-h-[min(46vh,420px)]">
          <ul className="flex flex-col gap-1.5 pr-2">
            {channel.chapters.map((chapter) => {
              const meta = kindMeta(chapter.kind);
              const Icon = meta.icon;
              const busy = busyId === chapter.id;
              const isIndex = chapter.kind === "index";
              const isDocument = chapter.kind === "document";
              const needsLogin =
                isDocument && chapter.document?.downloadable === false;
              const links = chapter.links ?? [];
              const selected = selectedFor(chapter);
              const open = expanded.has(chapter.id);
              return (
                <li
                  key={chapter.id}
                  data-testid="telegram-chapter"
                  className="rounded-xl border border-border/60 bg-card/70"
                >
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-[12px] font-semibold"
                        title={chapter.title}
                      >
                        {chapter.title}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                        <span>{t(meta.key)}</span>
                        {chapter.pageCount ? (
                          <span className="mono tabular-nums">
                            {chapter.pageCount} {t("common.pages")}
                          </span>
                        ) : null}
                        {isIndex ? (
                          <span className="mono tabular-nums">
                            {t("browser.telegram.indexCount", {
                              count: links.length,
                            })}
                          </span>
                        ) : null}
                        {chapter.grouped ? (
                          <span>{t("browser.telegram.grouped")}</span>
                        ) : null}
                        {chapter.viaInline ? (
                          <span
                            data-testid="telegram-inline-badge"
                            className="inline-flex items-center gap-0.5 font-semibold text-primary"
                          >
                            <Check className="size-3" aria-hidden />
                            {t("browser.telegram.viaInline")}
                          </span>
                        ) : null}
                        {needsLogin ? (
                          <span className="font-semibold text-warning">
                            {t("browser.telegram.loginRequiredBadge")}
                          </span>
                        ) : null}
                        {isDocument && chapter.document ? (
                          <span
                            className="mono max-w-full truncate tabular-nums"
                            title={chapter.document.filename}
                          >
                            {chapter.document.filename}
                            {chapter.document.size
                              ? ` · ${formatTelegramSize(chapter.document.size)}`
                              : ""}
                          </span>
                        ) : null}
                      </p>
                      {(chapter.tags ?? []).length > 0 ? (
                        <p className="mt-1 flex flex-wrap items-center gap-1">
                          {(chapter.tags ?? []).slice(0, 4).map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              disabled={searching}
                              data-testid="telegram-tag"
                              data-tag={tag}
                              onClick={() => onSearch(tag)}
                              title={t("browser.telegram.searchTag", { tag })}
                              className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] font-semibold text-primary transition hover:bg-accent disabled:opacity-50"
                            >
                              {tag}
                            </button>
                          ))}
                        </p>
                      ) : null}
                    </div>
                    {isIndex ? (
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          variant="pill-primary"
                          size="pill-sm"
                          className="whitespace-nowrap"
                          data-testid="telegram-index-import-all"
                          disabled={busyId !== null || links.length === 0}
                          onClick={() =>
                            onImportIndex(
                              chapter,
                              links.map((link) => link.url),
                            )
                          }
                        >
                          {busy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Download className="size-3.5" />
                          )}
                          {busy
                            ? t("browser.telegram.indexImporting")
                            : t("browser.telegram.indexImport", {
                                count: links.length,
                              })}
                        </Button>
                        <Button
                          type="button"
                          variant="pill"
                          size="pill-sm"
                          className="whitespace-nowrap"
                          aria-expanded={open}
                          data-testid="telegram-index-toggle"
                          onClick={() => toggleExpanded(chapter)}
                        >
                          {open ? (
                            <ChevronUp className="size-3.5" aria-hidden />
                          ) : (
                            <ChevronDown className="size-3.5" aria-hidden />
                          )}
                          {open
                            ? t("browser.telegram.indexCollapse")
                            : t("browser.telegram.indexExpand")}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="pill"
                        size="pill-sm"
                        className="shrink-0"
                        disabled={busyId !== null}
                        onClick={() => onImport(chapter)}
                      >
                        {busy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : isDocument ? (
                          <Download className="size-3.5" />
                        ) : (
                          <Images className="size-3.5" />
                        )}
                        {busy
                          ? isDocument
                            ? t("browser.telegram.downloading")
                            : t("browser.telegram.importing")
                          : needsLogin
                            ? t("browser.telegram.loginRequiredBadge")
                            : isDocument
                              ? t("browser.telegram.downloadDocument")
                              : t("browser.telegram.importChapter")}
                      </Button>
                    )}
                  </div>

                  {isIndex && open ? (
                    <div
                      className="mx-2 mb-2 flex flex-col gap-2 rounded-xl border border-dashed border-border/70 bg-background/50 p-2"
                      data-testid="telegram-index-links"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-[10px] leading-relaxed text-muted-foreground">
                          {t("browser.telegram.indexHint")}
                        </span>
                        <Button
                          type="button"
                          variant="pill"
                          size="pill-sm"
                          className="shrink-0"
                          onClick={() =>
                            setChapterSelection(
                              chapter,
                              new Set(links.map((link) => link.url)),
                            )
                          }
                        >
                          {t("browser.picker.selectAll")}
                        </Button>
                        <Button
                          type="button"
                          variant="pill"
                          size="pill-sm"
                          className="shrink-0"
                          onClick={() =>
                            setChapterSelection(
                              chapter,
                              new Set(
                                links
                                  .filter((link) => !selected.has(link.url))
                                  .map((link) => link.url),
                              ),
                            )
                          }
                        >
                          {t("browser.picker.invert")}
                        </Button>
                      </div>
                      <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
                        {links.map((link, index) => (
                          <li key={link.url}>
                            <label className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 text-[11px] hover:bg-accent">
                              <input
                                type="checkbox"
                                checked={selected.has(link.url)}
                                onChange={(event) =>
                                  toggleLink(
                                    chapter,
                                    link.url,
                                    event.currentTarget.checked,
                                  )
                                }
                                className="mt-0.5 size-3.5 shrink-0 accent-[var(--sh-primary)]"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">
                                  {index + 1}. {link.title}
                                </span>
                                <span className="mono block truncate text-[10px] text-muted-foreground">
                                  {onlineSourceAddress(link.url) ||
                                    t("source.hiddenAddress")}
                                </span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          variant="pill-primary"
                          size="pill-sm"
                          className="shrink-0 whitespace-nowrap"
                          data-testid="telegram-index-import"
                          disabled={busyId !== null || selected.size === 0}
                          onClick={() => onImportIndex(chapter, [...selected])}
                        >
                          {busy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Download className="size-3.5" />
                          )}
                          {busy
                            ? t("browser.telegram.indexImporting")
                            : t("browser.telegram.indexImport", {
                                count: selected.size,
                              })}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}

      {channel.hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button
            type="button"
            data-testid="telegram-load-more"
            variant="pill"
            size="pill-sm"
            disabled={loadingMore || searching}
            onClick={onLoadMore}
          >
            {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {loadingMore
              ? t("browser.telegram.loadingMore")
              : t("browser.telegram.loadMore")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
