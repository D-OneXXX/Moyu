import { useState, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsDialog } from "./SettingsDialog";
import { useSettingsSurface } from "./settingsSurface";

export interface SettingsDisclosure {
  /** 弹窗标题；缺省回落到分区标题。 */
  title?: string;
  description?: string;
  /** 一级入口行左侧标签。 */
  triggerLabel: string;
  /** 一级入口行右侧的状态摘要文本。 */
  triggerHint?: string;
  /** 弹窗宽度：md=520px 配置弹窗；lg=640px 规则/快捷键列表弹窗。 */
  width?: "md" | "lg";
  testId?: string;
}

interface SettingsSectionProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** 头部尾随插槽：一个徽章或单个紧凑按钮。 */
  action?: ReactNode;
  /** 状态摘要：指标/开关等停留在第一级的区块。 */
  summary?: ReactNode;
  /** 常驻行（每个行可能打开更深一层的弹窗）。 */
  rows?: ReactNode;
  /** 明细内容：无 `disclosure` 时内联；有则放入居中弹窗。 */
  children?: ReactNode;
  disclosure?: SettingsDisclosure;
  className?: string;
}

/**
 * 分组单层列表（Grouped Setting Rows）。
 *
 * 一级只保留「标题 + 状态摘要 + 高频即时行」；复杂低频模块一律下沉到
 * `disclosure` 的居中模态弹窗（Dialog），关闭时不挂载、不请求。
 * 排版固定：标题 14px/medium，副标题 12px/muted；行高 56px。
 */
export function SettingsSection({
  icon: Icon,
  title,
  description,
  action,
  summary,
  rows,
  children,
  disclosure,
  className,
}: SettingsSectionProps) {
  const surface = useSettingsSurface();
  const [open, setOpen] = useState(false);
  const flat = surface === "dialog";

  const header = (
    <div className="flex items-start gap-2 px-1">
      {Icon ? (
        <Icon
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          strokeWidth={2.2}
          aria-hidden
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium leading-5 tracking-tight text-foreground">
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );

  const body = summary || rows || children || disclosure ? (
    <div className="space-y-3">
      {summary}
      {rows || disclosure ? (
        <SettingsRowList>
          {rows}
          {disclosure ? (
            <SettingActionRow
              label={disclosure.triggerLabel}
              hint={disclosure.triggerHint}
              testId={disclosure.testId}
              onClick={() => setOpen(true)}
            />
          ) : null}
        </SettingsRowList>
      ) : null}
      {!disclosure ? children : null}
    </div>
  ) : null;

  return (
    <>
      <section className={cn("space-y-3", flat && "space-y-3", className)}>
        {header}
        {body}
      </section>
      {disclosure ? (
        <SettingsDialog
          open={open}
          onOpenChange={setOpen}
          title={disclosure.title ?? title}
          description={disclosure.description ?? description}
          width={disclosure.width}
        >
          {children}
        </SettingsDialog>
      ) : null}
    </>
  );
}

/**
 * 分组容器：一级页上是干净的圆角边框列表；居中弹窗内退化为纯细分割线列表，
 * 避免框套框。
 */
export function SettingsRowList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const surface = useSettingsSurface();
  const flat = surface === "dialog";
  return (
    <div
      className={cn(
        "divide-y divide-border/40 overflow-hidden",
        flat
          ? "border-0 bg-transparent"
          : "rounded-xl border border-border/60 bg-card/50",
        className,
      )}
      style={
        flat
          ? undefined
          : {
              borderWidth: "var(--mr-border-width)",
              borderStyle: "var(--mr-border-style)",
            }
      }
    >
      {children}
    </div>
  );
}

interface SettingRowProps {
  title: string;
  description?: string;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** 标准高度（56px）的标签行 + 尾随控件。标题 14px/medium，副标题 12px/muted。 */
export function SettingRow({
  title,
  description,
  badge,
  children,
  className,
}: SettingRowProps) {
  return (
    <div
      className={cn(
        "flex min-h-[56px] flex-wrap items-center justify-between gap-3 px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 truncate text-sm font-medium leading-5 text-foreground">
            {title}
          </p>
          {badge}
        </div>
        {description ? (
          <p className="mt-0.5 truncate text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

interface SettingActionRowProps {
  label: string;
  hint?: string;
  value?: ReactNode;
  icon?: LucideIcon;
  onClick: () => void;
  testId?: string;
  className?: string;
}

/**
 * 唯一合法的二级入口行：整行可点击，右侧为当前状态摘要 + 右箭头。
 */
export function SettingActionRow({
  label,
  hint,
  value,
  icon: Icon,
  onClick,
  testId,
  className,
}: SettingActionRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "group/row flex w-full min-h-[56px] cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 active:bg-muted/60",
        className,
      )}
    >
      {Icon ? (
        <Icon
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={2.2}
          aria-hidden
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-5 text-foreground">
          {label}
        </span>
        {hint ? (
          <span className="mt-0.5 block truncate text-xs leading-5 text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </span>
      {value ? (
        <span className="shrink-0 truncate text-xs tabular-nums text-muted-foreground">
          {value}
        </span>
      ) : null}
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/row:translate-x-0.5"
        aria-hidden
      />
    </button>
  );
}

/** 状态摘要里的紧凑指标。 */
export function SettingsStat({
  label,
  value,
  unit,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 flex items-baseline gap-1 text-base font-semibold leading-6 tabular-nums",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-destructive",
        )}
      >
        <span className="truncate">{value}</span>
        {unit ? (
          <span className="text-xs font-medium text-muted-foreground">
            {unit}
          </span>
        ) : null}
      </p>
    </div>
  );
}

export function SettingsStatRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded-xl border border-border/60 bg-card/50 px-4 py-3 sm:grid-cols-4">
      {children}
    </div>
  );
}
