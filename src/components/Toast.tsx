import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { translate, useI18n } from "@/i18n";
import { localizeBackendError } from "@/features/errors/localize";

/**
 * Toast 可选的行动按钮。
 *
 * 用于「错误提示旁给出下一步」这类场景：例如在线直读被功能开关挡住时，
 * 直接在提示里给出「立即开启」，用户不必先去设置页找开关。
 */
export interface ToastAction {
  label: string;
  onAction: () => void;
}

/** 错误 toast：后端中文详情只在中文本地化显示，其他语种使用本地化摘要。 */
export function toastErr(cmd: string, e: unknown): void {
  const msg =
    typeof e === "string"
      ? localizeBackendError(e)
      : translate("error.requestFailed", { cmd });
  toast(msg);
}

interface PendingToast {
  message: string;
  action?: ToastAction;
}

type ToastListener = (message: string, action?: ToastAction) => void;

const listeners = new Set<ToastListener>();
const pending: PendingToast[] = [];

/** 轻量 toast：任意处调用 toast(msg)，由当前挂载的 <Toaster/> 渲染 */
export function toast(message: string, action?: ToastAction): void {
  if (listeners.size > 0) {
    listeners.forEach((listener) => listener(message, action));
    return;
  }
  pending.push({ message, action });
  if (pending.length > 8) pending.shift();
}

interface ToastItem {
  id: number;
  msg: string;
  action?: ToastAction;
}

export function Toaster() {
  const { t } = useI18n();
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let nextId = 1;
    const handler: ToastListener = (msg, action) => {
      const id = nextId;
      nextId += 1;
      // 最多 3 条：超过会遮住底部批量操作条与内容。
      setItems((prev) => [...prev.slice(-2), { id, msg, action }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((item) => item.id !== id));
      }, 4200);
    };
    listeners.add(handler);
    if (pending.length > 0) {
      pending.splice(0).forEach((entry) => handler(entry.message, entry.action));
    }
    return () => {
      listeners.delete(handler);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-[var(--mr-toast-bottom,1.25rem)] left-1/2 z-[120] flex w-[min(92vw,460px)] -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="pointer-events-auto flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm font-medium text-card-foreground shadow-hard"
          role="status"
        >
          <span className="min-w-0 flex-1 break-words">{item.msg}</span>
          {item.action ? (
            <button
              type="button"
              className="shrink-0 rounded-full border border-border bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                item.action?.onAction();
                setItems((prev) => prev.filter((entry) => entry.id !== item.id));
              }}
            >
              {item.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() =>
              setItems((prev) => prev.filter((entry) => entry.id !== item.id))
            }
            aria-label={t("toast.close")}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
