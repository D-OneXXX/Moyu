import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Download,
  ImageOff,
  Loader2,
  RefreshCw,
  Server,
  Settings2,
  X,
} from "lucide-react";
import {
  api,
  type BookInfo,
  type OpdsConfigView,
  type OpdsEntry,
  type OpdsFeed,
} from "@/lib/tauri";
import { useI18n } from "@/i18n";
import { localizeBackendError } from "@/features/errors/localize";
import { recordBreadcrumb } from "@/features/resilience";
import { useFeatureEnabled } from "@/features/features";
import { FeatureDisabledNotice } from "@/components/settings/DeveloperFeaturePanel";
import { toast, toastErr } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenBook: (book: BookInfo) => void;
  onGoSettings: () => void;
}

interface Crumb {
  url: string;
  title: string;
}

/** 进程内封面缓存：URL 可能含 Kavita API key，只驻留内存，不写 DOM/日志。 */
const coverCache = new Map<string, string>();
const COVER_CACHE_LIMIT = 240;

function cacheCover(url: string, dataUrl: string): void {
  coverCache.set(url, dataUrl);
  while (coverCache.size > COVER_CACHE_LIMIT) {
    const oldest = coverCache.keys().next().value;
    if (oldest === undefined) break;
    coverCache.delete(oldest);
  }
}

function OpdsCover({
  url,
  title,
  alt,
}: {
  url: string | null | undefined;
  title: string;
  alt: string;
}) {
  const [source, setSource] = useState<string | null>(() =>
    url ? coverCache.get(url) ?? null : null,
  );
  const [visible, setVisible] = useState(false);
  const holder = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!url || source) return;
    const node = holder.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [url, source]);

  useEffect(() => {
    if (!url || source || !visible) return;
    let alive = true;
    api.getOpdsCover(url).then(
      (image) => {
        if (!alive) return;
        cacheCover(url, image.dataUrl);
        setSource(image.dataUrl);
      },
      () => {
        if (alive) setSource(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [url, source, visible]);

  return (
    <div
      ref={holder}
      className="flex aspect-[2/3] w-full items-center justify-center overflow-hidden bg-muted"
    >
      {source ? (
        <img
          src={source}
          alt={alt}
          title={title}
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <ImageOff
          className="size-8 text-muted-foreground/50"
          strokeWidth={1.4}
          aria-hidden
        />
      )}
    </div>
  );
}

/**
 * OPDS 1.2 远程书库浏览器：只读目录，逐级进入库/系列，选中章节下载到本地
 * 缓存后交给现有阅读管线。所有网络与凭据都在 Rust 侧，封面也由后端代理。
 */
export default function OpdsBrowserDialog(props: Props) {
  const enabled = useFeatureEnabled("opds");
  if (!enabled) return <OpdsFeatureDisabledDialog {...props} />;
  return <OpdsBrowserDialogBody {...props} />;
}

/**
 * 功能门卫关闭时的可恢复入口：不挂载 `getOpdsConfig` / `browseOpds`，
 * 因此不会在挂载时制造满屏 feature-disabled 报错。
 */
function OpdsFeatureDisabledDialog({ open, onOpenChange, onGoSettings }: Props) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid="opds-dialog-disabled"
        className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-hard sm:max-w-lg"
      >
        <Button
          variant="pill-ghost"
          size="pill-icon-sm"
          className="absolute right-3 top-3 z-10"
          onClick={() => onOpenChange(false)}
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          <X aria-hidden />
        </Button>
        <DialogHeader className="gap-2 border-b border-border px-6 pb-4 pr-14 pt-5">
          <DialogTitle className="text-lg font-bold leading-snug tracking-tight">
            {t("opds.dialog.title")}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-muted-foreground">
            {t("opds.dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto px-6 py-5">
          <FeatureDisabledNotice
            feature="opds"
            actions={
              <Button
                type="button"
                variant="pill"
                size="pill-sm"
                className="whitespace-nowrap"
                onClick={onGoSettings}
              >
                <Settings2 className="size-3.5" aria-hidden />
                {t("opds.dialog.goSettings")}
              </Button>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OpdsBrowserDialogBody({
  open,
  onOpenChange,
  onOpenBook,
  onGoSettings,
}: Props) {
  const { t, formatNumber } = useI18n();
  const [config, setConfig] = useState<OpdsConfigView | null>(null);
  const [feed, setFeed] = useState<OpdsFeed | null>(null);
  const [stack, setStack] = useState<Crumb[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [busyEntry, setBusyEntry] = useState<string | null>(null);

  const load = useCallback(
    async (url: string | null, pushCurrent: boolean) => {
      setLoading(true);
      setError(null);
      setDownloadError(null);
      try {
        if (pushCurrent && feed) {
          setStack((previous) => [
            ...previous,
            { url: feed.url, title: feed.title },
          ]);
        }
        const next = await api.browseOpds(url);
        setFeed(next);
      } catch (reason) {
        setError(localizeBackendError(reason));
      } finally {
        setLoading(false);
      }
    },
    [feed],
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setFeed(null);
    setStack([]);
    setConfig(null);
    setError(null);
    setDownloadError(null);
    setBusyEntry(null);
    setLoading(true);
    api.getOpdsConfig().then(
      async (value) => {
        if (!alive) return;
        setConfig(value);
        if (!value.enabled || value.url.trim().length === 0) {
          setLoading(false);
          return;
        }
        try {
          const root = await api.browseOpds(null);
          if (alive) setFeed(root);
        } catch (reason) {
          if (alive) setError(localizeBackendError(reason));
        } finally {
          if (alive) setLoading(false);
        }
      },
      (reason) => {
        if (!alive) return;
        setError(localizeBackendError(reason));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [open]);

  const enter = (entry: OpdsEntry) => {
    if (!entry.navigationUrl || loading) return;
    recordBreadcrumb("onlineRead");
    void load(entry.navigationUrl, true);
  };

  const download = async (entry: OpdsEntry) => {
    if (!entry.downloadUrl || busyEntry !== null) return;
    setBusyEntry(entry.downloadUrl);
    setDownloadError(null);
    try {
      const book = await api.downloadOpdsEntry(
        entry.downloadUrl,
        entry.title || t("opds.dialog.untitled"),
      );
      recordBreadcrumb("onlineRead");
      toast(
        t("opds.download.done", {
          title: book.title || t("opds.dialog.untitled"),
        }),
      );
      onOpenChange(false);
      onOpenBook(book);
    } catch (reason) {
      setDownloadError(
        t("opds.download.failed", {
          error: localizeBackendError(reason),
        }),
      );
      toastErr("opds_download_entry", reason);
    } finally {
      setBusyEntry(null);
    }
  };

  const back = () => {
    if (loading || stack.length === 0) return;
    const previous = stack[stack.length - 1];
    setStack((items) => items.slice(0, -1));
    void load(previous.url, false);
  };

  const disabled =
    config !== null &&
    (!config.enabled || config.url.trim().length === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid="opds-dialog"
        className="h-[min(88vh,780px)] w-[min(96vw,1080px)] max-w-[calc(100%-2rem)]! grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-hard sm:max-w-[1080px]!"
      >
        <Button
          variant="pill-ghost"
          size="pill-icon-sm"
          className="absolute right-3 top-3 z-10"
          onClick={() => onOpenChange(false)}
          aria-label={t("common.close")}
          title={t("common.close")}
          data-testid="opds-close"
        >
          <X aria-hidden />
        </Button>
        <DialogHeader className="gap-3 border-b border-border px-6 pb-4 pt-5 pr-14">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl border border-border bg-secondary text-secondary-foreground shadow-hard-sm">
              <Cloud className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-lg font-bold leading-snug tracking-tight">
                {t("opds.dialog.title")}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("opds.dialog.description")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-6 py-3">
          <Button
            variant="pill"
            size="pill-sm"
            onClick={back}
            disabled={loading || stack.length === 0}
            data-testid="opds-back"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            {t("opds.dialog.back")}
          </Button>
          <Button
            variant="pill"
            size="pill-sm"
            onClick={() => void load(feed?.url ?? null, false)}
            disabled={loading || disabled}
            aria-label={t("opds.dialog.refresh")}
            title={t("opds.dialog.refresh")}
            data-testid="opds-refresh"
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold" title={feed?.title}>
              {feed?.title || (disabled ? t("opds.dialog.disabledTitle") : t("opds.dialog.root"))}
            </p>
            {stack.length > 0 ? (
              <p className="truncate text-[10px] text-muted-foreground">
                {stack.map((crumb) => crumb.title).filter(Boolean).join(" / ")}
              </p>
            ) : null}
          </div>
          {feed ? (
            <Badge
              variant="outline"
              className="shrink-0 whitespace-nowrap tabular-nums"
            >
              {formatNumber(feed.entries.length)}
            </Badge>
          ) : null}
        </div>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          {downloadError && !disabled ? (
            <p
              role="alert"
              className="mb-4 break-words rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive"
            >
              {downloadError}
            </p>
          ) : null}
          {disabled ? (
            <div
              data-testid="opds-disabled"
              className="mx-auto flex max-w-xl flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-background/60 px-6 py-12 text-center"
            >
              <span className="grid size-12 place-items-center rounded-2xl border border-border bg-secondary shadow-hard-sm">
                <Server className="size-5" aria-hidden />
              </span>
              <h3 className="text-base font-bold">
                {t("opds.dialog.disabledTitle")}
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("opds.dialog.disabledBody")}
              </p>
              <Button
                variant="pill-primary"
                size="pill"
                onClick={() => {
                  onOpenChange(false);
                  onGoSettings();
                }}
              >
                <Settings2 className="size-4" aria-hidden />
                {t("opds.dialog.goSettings")}
              </Button>
            </div>
          ) : loading && !feed ? (
            <div className="flex flex-col items-center gap-3 py-16 text-xs text-muted-foreground">
              <Loader2 className="size-5 animate-spin" aria-hidden />
              {t("opds.dialog.loading")}
            </div>
          ) : error ? (
            <div className="mx-auto flex max-w-xl flex-col items-center gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-6 py-10 text-center">
              <p role="alert" className="break-words text-xs leading-relaxed text-destructive">
                {t("opds.dialog.loadFailed", { error })}
              </p>
              <Button
                variant="pill"
                size="pill-sm"
                onClick={() => void load(feed?.url ?? null, false)}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                {t("opds.dialog.refresh")}
              </Button>
            </div>
          ) : feed && feed.entries.length === 0 ? (
            <p className="py-16 text-center text-xs text-muted-foreground">
              {t("opds.dialog.empty")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {feed?.entries.map((entry, index) => {
                const title = entry.title || t("opds.dialog.untitled");
                const archive =
                  entry.archive === "zip"
                    ? t("opds.entry.archiveZip")
                    : entry.archive === "rar"
                      ? t("opds.entry.archiveRar")
                      : entry.archive === "auto"
                        ? t("opds.entry.archiveAuto")
                        : null;
                const busy =
                  entry.downloadUrl !== undefined &&
                  entry.downloadUrl !== null &&
                  busyEntry === entry.downloadUrl;
                return (
                  <article
                    key={`${entry.downloadUrl ?? entry.navigationUrl ?? index}-${index}`}
                    data-testid="opds-entry"
                    className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-background/80 shadow-hard-sm"
                  >
                    <button
                      type="button"
                      className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => enter(entry)}
                      disabled={!entry.navigationUrl || loading}
                      aria-label={title}
                      title={title}
                    >
                      <OpdsCover
                        url={entry.coverUrl}
                        title={title}
                        alt={t("opds.dialog.coverAlt", { title })}
                      />
                    </button>
                    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
                      <p
                        className="line-clamp-2 text-xs font-semibold leading-snug"
                        title={title}
                      >
                        {title}
                      </p>
                      <div className="mt-auto flex flex-wrap items-center gap-1.5">
                        {entry.navigationUrl ? (
                          <Button
                            variant="pill"
                            size="pill-sm"
                            className="min-w-0"
                            onClick={() => enter(entry)}
                            disabled={loading}
                            data-testid="opds-entry-open"
                          >
                            <BookOpen className="size-3.5" aria-hidden />
                            {t("opds.entry.navigation")}
                          </Button>
                        ) : null}
                        {entry.downloadUrl && archive ? (
                          <Button
                            variant="pill-primary"
                            size="pill-sm"
                            className="min-w-0"
                            onClick={() => void download(entry)}
                            disabled={busyEntry !== null || loading}
                            data-testid="opds-entry-download"
                            title={`${t("opds.entry.download")} · ${archive}`}
                          >
                            {busy ? (
                              <Loader2 className="size-3.5 animate-spin" aria-hidden />
                            ) : (
                              <Download className="size-3.5" aria-hidden />
                            )}
                            {busy
                              ? t("opds.entry.downloading")
                              : t("opds.entry.download")}
                          </Button>
                        ) : null}
                        {entry.downloadUrl && !archive ? (
                          <Badge variant="warning" className="shrink-0">
                            {t("opds.entry.unsupported")}
                          </Badge>
                        ) : null}
                        {archive ? (
                          <Badge variant="outline" className="shrink-0">
                            <Archive className="size-3" aria-hidden />
                            {archive}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-6 py-3">
          <Button
            variant="pill"
            size="pill-sm"
            onClick={() => feed?.prevUrl && void load(feed.prevUrl, false)}
            disabled={loading || !feed?.prevUrl}
            data-testid="opds-prev"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            {t("opds.dialog.prev")}
          </Button>
          <Button
            variant="pill"
            size="pill-sm"
            onClick={() => feed?.nextUrl && void load(feed.nextUrl, false)}
            disabled={loading || !feed?.nextUrl}
            data-testid="opds-next"
          >
            {t("opds.dialog.next")}
            <ChevronRight className="size-3.5" aria-hidden />
          </Button>
          <p className="ml-auto max-w-[52%] text-right text-[10px] leading-relaxed text-muted-foreground">
            {t("opds.dialog.footer")}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
