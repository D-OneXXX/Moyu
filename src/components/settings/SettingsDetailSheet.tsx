import type { ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { SettingsSurfaceProvider } from "./settingsSurface";

interface SettingsDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Secondary settings surface.
 *
 * Content is mounted by Base UI only while the sheet is open, so heavy
 * editors (rule lists, certificate blocks, diagnostic reports) cost nothing
 * until the user asks for them. The body owns its own scroll and keeps a
 * stable scrollbar gutter, which prevents the page underneath from shifting
 * when the sheet closes.
 */
export function SettingsDetailSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: SettingsDetailSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          "w-full gap-0 border-l border-border bg-card p-0 sm:max-w-xl data-[side=right]:sm:max-w-xl",
          className,
        )}
      >
        <SheetHeader className="shrink-0 gap-1 border-b border-border px-5 py-4 pr-12">
          <SheetTitle className="text-sm font-medium leading-5 tracking-tight">
            {title}
          </SheetTitle>
          {description ? (
            <SheetDescription className="line-clamp-3 text-xs leading-5 text-muted-foreground">
              {description}
            </SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-gutter:stable]">
          <SettingsSurfaceProvider value="sheet">
            <div className="space-y-5">{children}</div>
          </SettingsSurfaceProvider>
        </div>
        {footer ? (
          <div className="shrink-0 border-t border-border px-5 py-3">
            {footer}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
