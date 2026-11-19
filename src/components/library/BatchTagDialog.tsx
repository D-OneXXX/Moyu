import { useState } from "react";
import { Minus, Plus, Tag } from "lucide-react";
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
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookIds: string[];
  tags: TagInfo[];
  /** 任一变更成功后刷新书库与标签计数。 */
  onChanged: () => void | Promise<void>;
}

/**
 * 21-1 批量打标签：居中 Dialog，选择标签后立即应用并关闭。
 * 没有保存/取消底栏；危险动作只有「移除标签」，不触碰书籍本身。
 */
export default function BatchTagDialog({
  open,
  onOpenChange,
  bookIds,
  tags,
  onChanged,
}: Props) {
  const { t, formatNumber } = useI18n();
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");

  const apply = async (tag: TagInfo, mode: "add" | "remove") => {
    if (busy || bookIds.length === 0) return;
    setBusy(true);
    try {
      const changed =
        mode === "add"
          ? await api.batchAddTag(bookIds, tag.id)
          : await api.batchRemoveTag(bookIds, tag.id);
      toast(
        t(mode === "add" ? "tags.batchDoneAdd" : "tags.batchDoneRemove", {
          count: formatNumber(changed),
          name: tag.name,
        }),
      );
      await onChanged();
      onOpenChange(false);
    } catch (e) {
      toastErr(mode === "add" ? "batch_add_tag" : "batch_remove_tag", e);
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (name.length === 0 || name.length > 32) {
      toast(t("tags.invalidName"));
      return;
    }
    setBusy(true);
    try {
      const tag = await api.createTag(name);
      setNewName("");
      const changed = await api.batchAddTag(bookIds, tag.id);
      toast(
        t("tags.batchDoneAdd", {
          count: formatNumber(changed),
          name: tag.name,
        }),
      );
      await onChanged();
      onOpenChange(false);
    } catch (e) {
      toastErr("batch_add_tag", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(84vh,680px)] max-w-[calc(100%-2rem)] gap-0 overflow-hidden rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-hard sm:max-w-md"
        showCloseButton
      >
        <DialogHeader className="gap-2 border-b border-border px-5 pb-4 pt-5 pr-12">
          <span className="grid size-9 place-items-center rounded-full border border-border bg-primary/10 text-primary">
            <Tag className="size-4" />
          </span>
          <DialogTitle className="text-lg font-bold tracking-tight">
            {t("tags.batchTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-muted-foreground">
            {t("tags.batchDescription", {
              count: formatNumber(bookIds.length),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {tags.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t("tags.batchEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {tags.map((tag) => (
                <li
                  key={tag.id}
                  className="flex items-center gap-2 rounded-full border border-border bg-background py-1 pl-3 pr-1.5 shadow-hard-sm"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2.5 shrink-0 rounded-full border border-border",
                      !tag.color && "bg-primary",
                    )}
                    style={tag.color ? { backgroundColor: tag.color } : undefined}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {tag.name}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatNumber(tag.bookCount)}
                  </span>
                  <Button
                    variant="pill-ghost"
                    size="pill-icon-sm"
                    className="size-9 shrink-0 text-destructive"
                    aria-label={`${t("tags.batchRemove")}: ${tag.name}`}
                    title={t("tags.batchRemove")}
                    disabled={busy}
                    onClick={() => void apply(tag, "remove")}
                  >
                    <Minus />
                  </Button>
                  <Button
                    variant="pill-primary"
                    size="pill-icon-sm"
                    className="size-9 shrink-0"
                    aria-label={`${t("tags.batchAdd")}: ${tag.name}`}
                    title={t("tags.batchAdd")}
                    disabled={busy}
                    onClick={() => void apply(tag, "add")}
                  >
                    <Plus />
                  </Button>
                </li>
              ))}
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
                void createAndAdd();
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
            disabled={busy || newName.trim().length === 0}
            onClick={() => void createAndAdd()}
          >
            <Plus />
            {t("tags.create")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
