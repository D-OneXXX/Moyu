import { useEffect, useMemo, useState } from "react";
import { Check, Plus, Tag, Trash2 } from "lucide-react";
import { api, type TagInfo } from "@/lib/tauri";
import { useI18n } from "@/i18n";
import { toast, toastErr } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";

/** 预设柔和色板：只允许这些颜色进入标签胶囊。 */
export const TAG_COLORS = [
  "#FDE68A",
  "#FBCFE8",
  "#BFDBFE",
  "#BBF7D0",
  "#DDD6FE",
  "#FED7AA",
  "#A5F3FC",
  "#E5E7EB",
] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: TagInfo[];
  /** 任一变更成功后刷新全局标签（计数/筛选下拉）。 */
  onChanged: () => void | Promise<void>;
}

/**
 * 21-1 标签管理器：居中模态 Dialog + 调整即自动保存。
 * 支持改名（失焦/回车保存）、预设柔和色、删除；没有保存/取消底栏。
 */
export default function TagManagerDialog({
  open,
  onOpenChange,
  tags,
  onChanged,
}: Props) {
  const { t, formatNumber } = useI18n();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TagInfo | null>(null);

  useEffect(() => {
    if (!open) return;
    setDrafts(
      Object.fromEntries(tags.map((tag) => [tag.id, tag.name])) as Record<
        number,
        string
      >,
    );
  }, [open, tags]);

  const sorted = useMemo(
    () =>
      [...tags].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    [tags],
  );

  const commitRename = async (tag: TagInfo, color?: string | null) => {
    const nextName = (drafts[tag.id] ?? tag.name).trim();
    if (nextName === tag.name && color === undefined) return;
    if (nextName.length === 0 || nextName.length > 32) {
      setDrafts((prev) => ({ ...prev, [tag.id]: tag.name }));
      toast(t("tags.invalidName"));
      return;
    }
    setBusyId(tag.id);
    try {
      await api.renameTag(tag.id, nextName, color ?? null);
      await onChanged();
    } catch (e) {
      setDrafts((prev) => ({ ...prev, [tag.id]: tag.name }));
      toastErr("rename_tag", e);
    } finally {
      setBusyId(null);
    }
  };

  const commitColor = async (tag: TagInfo, color: string) => {
    if (tag.color === color) return;
    setBusyId(tag.id);
    try {
      await api.renameTag(tag.id, tag.name, color);
      await onChanged();
    } catch (e) {
      toastErr("rename_tag", e);
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (name.length === 0 || name.length > 32) {
      toast(t("tags.invalidName"));
      return;
    }
    setCreating(true);
    try {
      await api.createTag(name);
      setNewName("");
      await onChanged();
    } catch (e) {
      toastErr("create_tag", e);
    } finally {
      setCreating(false);
    }
  };

  const remove = async (tag: TagInfo) => {
    setDeleteTarget(null);
    setBusyId(tag.id);
    try {
      await api.deleteTag(tag.id);
      toast(t("tags.deleted"));
      await onChanged();
    } catch (e) {
      toastErr("delete_tag", e);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-h-[min(86vh,720px)] max-w-[calc(100%-2rem)] gap-0 overflow-hidden rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-hard sm:max-w-lg"
          showCloseButton
        >
          <DialogHeader className="gap-2 border-b border-border px-5 pb-4 pt-5 pr-12">
            <span className="grid size-9 place-items-center rounded-full border border-border bg-primary/10 text-primary">
              <Tag className="size-4" />
            </span>
            <DialogTitle className="text-lg font-bold tracking-tight">
              {t("tags.managerTitle")}
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed text-muted-foreground">
              {t("tags.managerDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            {sorted.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("tags.emptyManager")}
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {sorted.map((tag) => {
                  const busy = busyId === tag.id;
                  return (
                    <li
                      key={tag.id}
                      className="rounded-2xl border border-border bg-background p-3 shadow-hard-sm"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            "size-3 shrink-0 rounded-full border border-border",
                            !tag.color && "bg-primary",
                          )}
                          style={
                            tag.color ? { backgroundColor: tag.color } : undefined
                          }
                        />
                        <Input
                          value={drafts[tag.id] ?? tag.name}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [tag.id]: e.target.value,
                            }))
                          }
                          onBlur={() => void commitRename(tag)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              e.currentTarget.blur();
                            }
                          }}
                          aria-label={t("tags.nameLabel")}
                          aria-invalid={
                            (drafts[tag.id] ?? tag.name).trim().length === 0
                          }
                          disabled={busy}
                          maxLength={32}
                          className="h-9 flex-1 text-sm"
                        />
                        <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
                          {t("library.countBooks", {
                            count: formatNumber(tag.bookCount),
                          })}
                        </span>
                        <Button
                          variant="pill-ghost"
                          size="pill-icon-sm"
                          className="relative size-9 shrink-0 text-destructive before:absolute before:-inset-1.5 before:content-['']"
                          aria-label={t("tags.delete")}
                          title={t("tags.delete")}
                          disabled={busy}
                          onClick={() => setDeleteTarget(tag)}
                        >
                          <Trash2 />
                        </Button>
                      </div>

                      <div
                        role="group"
                        aria-label={t("tags.colorAria")}
                        className="mt-2 flex flex-wrap items-center gap-1.5 pl-5"
                      >
                        {TAG_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            aria-label={color}
                            aria-pressed={tag.color === color}
                            disabled={busy}
                            onClick={() => void commitColor(tag, color)}
                            className={cn(
                              "relative grid size-7 place-items-center rounded-full border border-border outline-none transition-transform before:absolute before:-inset-2 before:content-[''] hover:scale-110 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50",
                              tag.color === color && "ring-2 ring-foreground",
                            )}
                            style={{ backgroundColor: color }}
                          >
                            {tag.color === color ? (
                              <Check className="size-3.5 text-background" strokeWidth={3} />
                            ) : null}
                          </button>
                        ))}
                        <button
                          type="button"
                          aria-label={t("tags.noColor")}
                          aria-pressed={!tag.color}
                          disabled={busy}
                          onClick={() => void commitColor(tag, "")}
                          className={cn(
                            "relative grid size-7 place-items-center rounded-full border border-dashed border-border bg-card text-[9px] font-bold text-muted-foreground outline-none before:absolute before:-inset-2 before:content-[''] focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50",
                            !tag.color && "ring-2 ring-foreground",
                          )}
                        >
                          —
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/30 px-5 py-3">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
              }}
              placeholder={t("tags.createPlaceholder")}
              aria-label={t("tags.create")}
              maxLength={32}
              className="h-9 flex-1 text-sm"
            />
            <Button
              variant="pill-primary"
              size="pill-sm"
              className="shrink-0 whitespace-nowrap"
              disabled={creating || newName.trim().length === 0}
              onClick={() => void create()}
            >
              <Plus />
              {t("tags.create")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {deleteTarget ? (
        <ConfirmDialog
          title={t("tags.deleteConfirmTitle", { name: deleteTarget.name })}
          message={t("tags.deleteConfirmMessage")}
          confirmText={t("tags.delete")}
          onConfirm={() => void remove(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      ) : null}
    </>
  );
}
