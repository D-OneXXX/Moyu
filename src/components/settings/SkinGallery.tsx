import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  Download,
  ImagePlus,
  Loader2,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { useI18n, type MessageKey } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import ConfirmDialog from "@/components/ConfirmDialog";
import { toast } from "@/components/Toast";
import { localizeBackendError } from "@/features/errors/localize";
import {
  createCustomSkin,
  deleteSkinPack,
  exportSkinPack,
  importSkinPack,
  listInstalledSkins,
  pickBackdropImage,
  pickFrameImage,
  readSkinArtwork,
} from "@/features/skin/api";
import {
  BUILTIN_SKINS,
  localizedSkinText,
  skinDescriptionText,
  skinDisplayName,
} from "@/features/skin/registry";
import { useSkin } from "@/features/skin/SkinProvider";
import type {
  InstalledSkinSummary,
  SkinColorScheme,
} from "@/features/skin/types";

const SCHEME_LABEL: Record<SkinColorScheme, MessageKey> = {
  light: "settings.skin.colorLight",
  dark: "settings.skin.colorDark",
  both: "settings.skin.colorBoth",
};

const PREVIEW_DEFAULTS: Record<string, string> = {
  "--mr-skin-canvas-bg": "var(--sh-background)",
  "--mr-skin-backdrop-image": "none",
  "--mr-skin-backdrop-size": "cover",
  "--mr-skin-backdrop-position": "center",
  "--mr-skin-frame-overlay": "none",
  "--mr-skin-frame-size": "cover",
  "--mr-skin-frame-position": "center",
  "--mr-skin-viewport-inset": "0px",
  "--mr-skin-viewport-radius": "0px",
  "--mr-skin-viewport-border": "0px solid transparent",
  "--mr-skin-viewport-shadow": "none",
  "--mr-skin-surface-bg": "var(--sh-background)",
  "--mr-skin-surface-tint": "transparent",
  "--mr-skin-surface-opacity": "1",
  "--mr-skin-surface-blur": "0px",
};

function firstInset(value: string | undefined): number {
  const first = (value ?? "0px").trim().split(/\s+/)[0] ?? "0px";
  const parsed = Number.parseFloat(first);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileBaseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * 皮肤缩略图：用真实 token 在卡片内复刻「整页画布 + 内嵌视窗」。
 * 只是为了辨认气质，内缩值按比例缩小，不参与真实布局。
 */
function SkinThumb({
  tokens,
  fallbackPreview,
  label,
}: {
  tokens: Record<string, string>;
  fallbackPreview?: string | null;
  label: string;
}) {
  const variables: Record<string, string> = {
    ...PREVIEW_DEFAULTS,
    ...tokens,
  };
  if (!tokens["--mr-skin-backdrop-image"] && fallbackPreview) {
    variables["--mr-skin-backdrop-image"] = `url("${fallbackPreview}")`;
  }
  const scaledInset = Math.min(
    22,
    Math.round(firstInset(tokens["--mr-skin-viewport-inset"]) * 0.55),
  );
  variables["--mr-skin-viewport-inset"] = `${scaledInset}px`;

  return (
    <div
      className="relative aspect-[16/10] w-full overflow-hidden rounded-xl border border-border/70 bg-muted"
      style={variables as CSSProperties}
      role="img"
      aria-label={label}
    >
      <div
        className="absolute inset-0"
        style={{ background: "var(--mr-skin-canvas-bg)" }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "var(--mr-skin-backdrop-image)",
          backgroundSize: "var(--mr-skin-backdrop-size)",
          backgroundPosition: "var(--mr-skin-backdrop-position)",
          backgroundRepeat: "no-repeat",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "var(--mr-skin-frame-overlay)",
          backgroundSize: "var(--mr-skin-frame-size)",
          backgroundPosition: "var(--mr-skin-frame-position)",
          backgroundRepeat: "no-repeat",
        }}
      />
      <div
        className="absolute flex min-h-0 min-w-0 flex-col gap-1.5 p-2"
        style={{
          inset: "var(--mr-skin-viewport-inset)",
          borderRadius: "var(--mr-skin-viewport-radius)",
          border: "var(--mr-skin-viewport-border)",
          background: "var(--mr-skin-surface-bg)",
          boxShadow: "var(--mr-skin-viewport-shadow)",
          overflow: "hidden",
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            background: "var(--mr-skin-surface-tint)",
            opacity: "var(--mr-skin-surface-opacity)",
            backdropFilter: "blur(var(--mr-skin-surface-blur))",
          }}
        />
        <div className="relative z-10 flex min-w-0 items-center gap-1.5">
          <span className="h-2 w-10 rounded-full bg-foreground/25" />
          <span className="h-2 w-5 rounded-full bg-foreground/15" />
          <span className="ml-auto h-2 w-2 rounded-full bg-foreground/20" />
        </div>
        <div className="relative z-10 grid grid-cols-3 gap-1.5">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <span
              key={index}
              className="h-6 rounded-md bg-foreground/12"
            />
          ))}
        </div>
        <div className="relative z-10 mt-auto space-y-1">
          <span className="block h-1.5 w-3/4 rounded-full bg-foreground/15" />
          <span className="block h-1.5 w-1/2 rounded-full bg-foreground/10" />
        </div>
      </div>
    </div>
  );
}

function notifyError(error: unknown): void {
  toast(localizeBackendError(error));
}

/**
 * 皮肤工坊（Task 21-3）。
 *
 * 居中大弹窗里的 2–3 列展厅：内置预设与本地 `.moyuskin` 包并列，
 * 点击即切换并自动保存。导入/导出/删除与「快速自制」都在同一面，
 * 没有任何漂浮挂件，也没有底部保存栏。
 */
export default function SkinGallery() {
  const { t, locale } = useI18n();
  const { skin, setSkin, activateInstalledSkin, removeInstalledSkin } =
    useSkin();
  const [installed, setInstalled] = useState<InstalledSkinSummary[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<InstalledSkinSummary | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);

  const [draftName, setDraftName] = useState("");
  const [backdropPath, setBackdropPath] = useState<string | null>(null);
  const [backdropPreview, setBackdropPreview] = useState<string | null>(null);
  const [framePath, setFramePath] = useState<string | null>(null);
  const [framePreview, setFramePreview] = useState<string | null>(null);
  const [inset, setInset] = useState(20);
  const [opacity, setOpacity] = useState(88);

  const refresh = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      setInstalled(await listInstalledSkins());
    } catch {
      /* 纯 Web/无后端环境：展厅仍显示内置预设。 */
      setInstalled([]);
    } finally {
      setLoadingInstalled(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mergeInstalled = useCallback((summary: InstalledSkinSummary) => {
    setInstalled((previous) => [
      summary,
      ...previous.filter((item) => item.id !== summary.id),
    ]);
  }, []);

  const selectSkin = useCallback(
    async (id: string, installedSkin: boolean) => {
      setBusy(id);
      try {
        const applied = installedSkin
          ? await activateInstalledSkin(id)
          : setSkin(id);
        if (!applied) toast(t("settings.skin.errorWrite"));
      } catch (error) {
        notifyError(error);
      } finally {
        setBusy(null);
      }
    },
    [activateInstalledSkin, setSkin, t],
  );

  const handleImport = useCallback(async () => {
    setBusy("import");
    try {
      const summary = await importSkinPack();
      if (!summary) return;
      mergeInstalled(summary);
      const applied = await activateInstalledSkin(summary.id);
      if (applied) {
        toast(t("settings.skin.importDone"));
      } else {
        toast(t("settings.skin.errorWrite"));
      }
      void refresh();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(null);
    }
  }, [activateInstalledSkin, mergeInstalled, refresh, t]);

  const handleExport = useCallback(
    async (summary: InstalledSkinSummary) => {
      setBusy(`export-${summary.id}`);
      try {
        const name =
          localizedSkinText(summary.name, locale) ?? summary.id;
        if (await exportSkinPack(summary.id, name)) {
          toast(t("settings.skin.exportDone"));
        }
      } catch (error) {
        notifyError(error);
      } finally {
        setBusy(null);
      }
    },
    [locale, t],
  );

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setBusy(`delete-${target.id}`);
    try {
      await deleteSkinPack(target.id);
      removeInstalledSkin(target.id);
      setInstalled((previous) =>
        previous.filter((item) => item.id !== target.id),
      );
      toast(t("settings.skin.deleteDone"));
      setPendingDelete(null);
      void refresh();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(null);
    }
  }, [pendingDelete, refresh, removeInstalledSkin, t]);

  const pickBackdrop = useCallback(async () => {
    const path = await pickBackdropImage();
    if (!path) return;
    try {
      const asset = await readSkinArtwork(path);
      setBackdropPath(path);
      setBackdropPreview(asset.dataUrl);
    } catch (error) {
      notifyError(error);
    }
  }, []);

  const pickFrame = useCallback(async () => {
    const path = await pickFrameImage();
    if (!path) return;
    try {
      const asset = await readSkinArtwork(path);
      setFramePath(path);
      setFramePreview(asset.dataUrl);
    } catch (error) {
      notifyError(error);
    }
  }, []);

  const resetBuilder = useCallback(() => {
    setDraftName("");
    setBackdropPath(null);
    setBackdropPreview(null);
    setFramePath(null);
    setFramePreview(null);
    setInset(20);
    setOpacity(88);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!backdropPath || !draftName.trim()) return;
    setBusy("create");
    try {
      const summary = await createCustomSkin({
        name: draftName.trim(),
        backdropPath,
        framePath,
        insetPx: inset,
        opacity: opacity / 100,
      });
      mergeInstalled(summary);
      await activateInstalledSkin(summary.id);
      toast(t("settings.skin.createDone"));
      resetBuilder();
      setBuilderOpen(false);
      void refresh();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(null);
    }
  }, [
    activateInstalledSkin,
    backdropPath,
    draftName,
    framePath,
    inset,
    mergeInstalled,
    opacity,
    refresh,
    resetBuilder,
    t,
  ]);

  const draftTokens = useMemo<Record<string, string>>(() => {
    const tokens: Record<string, string> = {
      "--mr-skin-viewport-inset": `${inset}px`,
      "--mr-skin-viewport-radius": "24px",
      "--mr-skin-surface-bg": "transparent",
      "--mr-skin-surface-tint": "var(--sh-card)",
      "--mr-skin-surface-opacity": (opacity / 100).toFixed(2),
      "--mr-skin-surface-blur": "14px",
    };
    if (backdropPreview) {
      tokens["--mr-skin-backdrop-image"] = `url("${backdropPreview}")`;
    }
    if (framePreview) {
      tokens["--mr-skin-frame-overlay"] = `url("${framePreview}")`;
    }
    return tokens;
  }, [backdropPreview, framePreview, inset, opacity]);

  const handleDeleteName = pendingDelete
    ? localizedSkinText(pendingDelete.name, locale) ?? pendingDelete.id
    : "";

  return (
    <div className="space-y-4" data-testid="skin-gallery">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="pill-primary"
          size="pill-sm"
          data-testid="skin-import"
          disabled={busy !== null}
          onClick={() => void handleImport()}
        >
          {busy === "import" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Upload className="size-3.5" />
          )}
          <span className="whitespace-nowrap">{t("settings.skin.importPack")}</span>
        </Button>
        <Button
          type="button"
          variant="pill"
          size="pill-sm"
          data-testid="skin-create-custom"
          aria-expanded={builderOpen}
          disabled={busy !== null}
          onClick={() => setBuilderOpen((value) => !value)}
        >
          <Wand2 className="size-3.5" />
          <span className="whitespace-nowrap">{t("settings.skin.createCustom")}</span>
        </Button>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          {loadingInstalled ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            t("settings.skin.installedCount", { count: installed.length })
          )}
        </span>
      </div>

      {builderOpen ? (
        <div
          className="space-y-3 rounded-2xl border border-border bg-muted/30 p-3 sm:p-4"
          data-testid="skin-builder"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-5">
                {t("settings.skin.builderTitle")}
              </p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t("settings.skin.builderHint")}
              </p>
            </div>
            <Button
              type="button"
              variant="pill-ghost"
              size="pill-icon-sm"
              className="shrink-0"
              aria-label={t("common.close")}
              onClick={() => setBuilderOpen(false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
            <div className="min-w-0 space-y-3">
              <label className="block min-w-0 space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("settings.skin.nameLabel")}
                </span>
                <Input
                  value={draftName}
                  maxLength={64}
                  placeholder={t("settings.skin.namePlaceholder")}
                  data-testid="skin-builder-name"
                  onChange={(event) => setDraftName(event.target.value)}
                />
              </label>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="min-w-0 rounded-xl bg-card/60 p-2.5">
                  <p className="text-xs font-medium">
                    {t("settings.skin.backdropLabel")}
                  </p>
                  <Button
                    type="button"
                    variant="pill"
                    size="pill-sm"
                    className="mt-2 max-w-full"
                    onClick={() => void pickBackdrop()}
                  >
                    <ImagePlus className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">
                      {backdropPath
                        ? fileBaseName(backdropPath)
                        : t("settings.library.pick")}
                    </span>
                  </Button>
                  <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                    {t("settings.skin.backdropHint")}
                  </p>
                </div>
                <div className="min-w-0 rounded-xl bg-card/60 p-2.5">
                  <p className="text-xs font-medium">
                    {t("settings.skin.frameLabel")}
                  </p>
                  <div className="mt-2 flex min-w-0 items-center gap-1.5">
                    <Button
                      type="button"
                      variant="pill"
                      size="pill-sm"
                      className="min-w-0"
                      onClick={() => void pickFrame()}
                    >
                      <ImagePlus className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate">
                        {framePath
                          ? fileBaseName(framePath)
                          : t("settings.skin.frameNone")}
                      </span>
                    </Button>
                    {framePath ? (
                      <Button
                        type="button"
                        variant="pill-ghost"
                        size="pill-icon-sm"
                        className="shrink-0"
                        aria-label={t("settings.skin.frameNone")}
                        onClick={() => {
                          setFramePath(null);
                          setFramePreview(null);
                        }}
                      >
                        <X className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                    {t("settings.skin.frameHint")}
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("settings.skin.insetLabel")}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums">
                      {t("settings.skin.numericValue", {
                        value: inset,
                        unit: "px",
                      })}
                    </span>
                  </div>
                  <Slider
                    value={[inset]}
                    min={0}
                    max={32}
                    step={1}
                    getAriaLabel={() => t("settings.skin.insetLabel")}
                    onValueChange={(value) =>
                      setInset(
                        typeof value === "number" ? value : value[0] ?? 0,
                      )
                    }
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("settings.skin.opacityLabel")}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums">
                      {t("settings.skin.numericValue", {
                        value: opacity,
                        unit: "%",
                      })}
                    </span>
                  </div>
                  <Slider
                    value={[opacity]}
                    min={70}
                    max={100}
                    step={1}
                    getAriaLabel={() => t("settings.skin.opacityLabel")}
                    onValueChange={(value) =>
                      setOpacity(
                        typeof value === "number" ? value : value[0] ?? 70,
                      )
                    }
                  />
                </div>
              </div>
            </div>

            <div className="min-w-0">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                {t("settings.skin.previewLabel")}
              </p>
              <SkinThumb
                tokens={draftTokens}
                label={t("settings.skin.previewLabel")}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              type="button"
              variant="pill-primary"
              size="pill-sm"
              data-testid="skin-builder-create"
              disabled={
                busy !== null || !backdropPath || !draftName.trim()
              }
              onClick={() => void handleCreate()}
            >
              {busy === "create" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Wand2 className="size-3.5" />
              )}
              <span className="whitespace-nowrap">
                {busy === "create"
                  ? t("settings.skin.creating")
                  : t("settings.skin.createAction")}
              </span>
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {BUILTIN_SKINS.map((item) => {
          const active = skin.id === item.id;
          const name = skinDisplayName(item, locale, t);
          const description = skinDescriptionText(item, locale, t);
          return (
            <div
              key={item.id}
              className="flex min-w-0 flex-col rounded-2xl border border-border bg-background/60 p-2.5"
            >
              <button
                type="button"
                aria-pressed={active}
                disabled={busy !== null}
                data-testid={`skin-card-${item.id}`}
                onClick={() => void selectSkin(item.id, false)}
                className="min-w-0 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait"
              >
                <SkinThumb tokens={item.tokens ?? {}} label={name} />
                <span className="mt-2 flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-semibold">
                    {name}
                  </span>
                  {active ? (
                    <Badge variant="success" className="shrink-0 whitespace-nowrap">
                      {t("settings.skin.active")}
                    </Badge>
                  ) : busy === item.id ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  ) : null}
                </span>
                {description ? (
                  <span className="mt-0.5 block line-clamp-2 min-w-0 text-xs leading-5 text-muted-foreground">
                    {description}
                  </span>
                ) : null}
                <span className="mt-1.5 flex min-w-0 items-center gap-1.5">
                  <Badge variant="muted" className="shrink-0 whitespace-nowrap">
                    {t("settings.skin.builtin")}
                  </Badge>
                  <Badge variant="outline" className="shrink-0 whitespace-nowrap">
                    {t(SCHEME_LABEL[item.colorScheme ?? "both"])}
                  </Badge>
                </span>
              </button>
            </div>
          );
        })}

        {installed.map((item) => {
          const active = skin.id === item.id;
          const name = localizedSkinText(item.name, locale) ?? item.id;
          const description = localizedSkinText(item.description, locale);
          const exporting = busy === `export-${item.id}`;
          const deleting = busy === `delete-${item.id}`;
          return (
            <div
              key={item.id}
              className="flex min-w-0 flex-col rounded-2xl border border-border bg-background/60 p-2.5"
            >
              <button
                type="button"
                aria-pressed={active}
                disabled={busy !== null}
                data-testid={`skin-card-${item.id}`}
                onClick={() => void selectSkin(item.id, true)}
                className="min-w-0 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait"
              >
                <SkinThumb
                  tokens={item.tokens ?? {}}
                  fallbackPreview={item.previewDataUrl}
                  label={name}
                />
                <span className="mt-2 flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-semibold">
                    {name}
                  </span>
                  {active ? (
                    <Badge variant="success" className="shrink-0 whitespace-nowrap">
                      {t("settings.skin.active")}
                    </Badge>
                  ) : busy === item.id ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  ) : null}
                </span>
                {description ? (
                  <span className="mt-0.5 block line-clamp-2 min-w-0 text-xs leading-5 text-muted-foreground">
                    {description}
                  </span>
                ) : null}
                <span className="mt-1.5 flex min-w-0 items-center gap-1.5">
                  <Badge variant="muted" className="shrink-0 whitespace-nowrap">
                    {t("settings.skin.installed")}
                  </Badge>
                  <Badge variant="outline" className="shrink-0 whitespace-nowrap">
                    {t(SCHEME_LABEL[item.colorScheme])}
                  </Badge>
                </span>
              </button>
              <div className="mt-2 flex shrink-0 items-center justify-end gap-1">
                <Button
                  type="button"
                  variant="pill-ghost"
                  size="pill-icon-sm"
                  aria-label={t("settings.skin.export")}
                  title={t("settings.skin.export")}
                  data-testid={`skin-export-${item.id}`}
                  disabled={busy !== null}
                  onClick={() => void handleExport(item)}
                >
                  {exporting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="pill-ghost"
                  size="pill-icon-sm"
                  className="text-destructive hover:text-destructive"
                  aria-label={t("settings.skin.delete")}
                  title={t("settings.skin.delete")}
                  data-testid={`skin-delete-${item.id}`}
                  disabled={busy !== null}
                  onClick={() => setPendingDelete(item)}
                >
                  {deleting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {pendingDelete ? (
        <ConfirmDialog
          title={t("settings.skin.deleteTitle")}
          message={t("settings.skin.deleteBody", { name: handleDeleteName })}
          confirmText={t("settings.skin.delete")}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void handleDelete()}
        />
      ) : null}
    </div>
  );
}
