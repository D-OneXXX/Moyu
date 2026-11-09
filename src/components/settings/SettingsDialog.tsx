import type { ReactNode } from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { SettingsSurfaceProvider } from "./settingsSurface";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** md = 520px 普通配置弹窗；lg = 640px 规则/快捷键列表弹窗。 */
  width?: "md" | "lg";
  children: ReactNode;
  className?: string;
}

/**
 * 设置页唯一的二级面：屏幕正中央的模态弹窗（Centered Modal Dialog）。
 *
 * - 固定精致宽度，柔和遮罩（bg-black/40 + backdrop-blur-xs），大圆角 + 内发光，
 *   150ms 缩放淡入；点击遮罩或按 Escape 随时关闭（Base UI 默认行为）。
 * - 顶部仅有「标题 + 右上角关闭按钮」，无底部「保存/取消」栏。
 * - 内容只在打开时挂载（Base UI 卸载 Popup），规则列表 / 证书 / 诊断等重模块
 *   在关闭时零请求、零 DOM。
 */
export function SettingsDialog({
  open,
  onOpenChange,
  title,
  description,
  width = "md",
  children,
  className,
}: SettingsDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "gap-0 p-0 sm:max-w-[520px]",
          width === "lg" && "sm:max-w-[640px]",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="min-w-0">
            <DialogTitle className="text-sm font-semibold leading-5 tracking-tight text-foreground">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
                {description}
              </DialogDescription>
            ) : null}
          </div>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon"
                className="-mr-1.5 -mt-1 shrink-0 text-muted-foreground hover:text-foreground"
              />
            }
          >
            <X className="size-4" />
            <span className="sr-only">{t("common.close")}</span>
          </DialogClose>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-gutter:stable]">
          <SettingsSurfaceProvider value="dialog">
            <div className="space-y-5">{children}</div>
          </SettingsSurfaceProvider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
