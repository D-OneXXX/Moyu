import { AlertTriangle, Check } from "lucide-react";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  title: string;
  message?: string;
  /** 将被删除的路径清单（已脱敏，等宽小字逐行列出）。 */
  paths?: string[];
  confirmText?: string;
  /** 破坏性操作使用 danger（默认）；批准等正向确认使用 primary。 */
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 胶囊风格确认对话框：shadcn/base-ui Dialog。
 * 关闭（Esc / 遮罩点击）等价于取消；危险操作使用 pill-danger 按钮。
 */
export default function ConfirmDialog({
  title,
  message,
  paths,
  confirmText,
  tone = "danger",
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const positive = tone === "primary";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        role="alertdialog"
        className="max-h-[calc(100vh-2rem)] max-w-[calc(100%-2rem)] gap-0 overflow-y-auto overflow-x-hidden rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-hard sm:max-w-md"
      >
        <DialogHeader className="gap-3 px-6 pb-4 pt-6">
          <span
            className={
              positive
                ? "grid size-10 place-items-center rounded-full border border-border bg-primary/10 text-primary"
                : "grid size-10 place-items-center rounded-full border border-border bg-destructive/10 text-destructive"
            }
          >
            {positive ? (
              <Check className="size-5" />
            ) : (
              <AlertTriangle className="size-5" />
            )}
          </span>
          <DialogTitle className="text-lg font-bold leading-snug tracking-tight">
            {title}
          </DialogTitle>
          {message ? (
            <DialogDescription className="break-words text-sm leading-relaxed text-muted-foreground">
              {message}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {paths && paths.length > 0 ? (
          <div className="mx-6 mb-5 max-h-44 overflow-y-auto rounded-xl border border-border bg-muted/60 p-3">
            <ul className="space-y-1.5">
              {paths.map((path, index) => (
                <li
                  key={`${index}-${path}`}
                  className="break-all font-mono text-[11px] leading-relaxed text-muted-foreground"
                >
                  {path}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <DialogFooter className="mx-0 mb-0 flex-row justify-end rounded-b-2xl border-t border-border bg-muted/40 px-6 py-4">
          <Button variant="pill" size="pill-sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={positive ? "pill-primary" : "pill-danger"}
            size="pill-sm"
            onClick={onConfirm}
          >
            {confirmText ?? t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
