import { useState, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { SettingsDetailSheet } from "./SettingsDetailSheet";
import { useSettingsSurface } from "./settingsSurface";

export interface SettingsDisclosure {
  /** Sheet heading. Defaults to the section title. */
  title?: string;
  description?: string;
  /** Label of the always-visible entry row. */
  triggerLabel: string;
  /** Right-aligned status subtext on the entry row. */
  triggerHint?: string;
  testId?: string;
}

interface SettingsSectionProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Header trailing slot: a badge or a single compact button. */
  action?: ReactNode;
  /** Status summary: metrics/switches that stay on the first-level panel. */
  summary?: ReactNode;
  /** Always-visible action rows (each one opens a deeper surface). */
  rows?: ReactNode;
  /** Detail content: inline without `disclosure`, sheet-only with it. */
  children?: ReactNode;
  disclosure?: SettingsDisclosure;
  className?: string;
}

/**
 * Settings card.
 *
 * Progressive disclosure contract (Task 2/8):
 *  - first level = header + status summary + action rows;
 *  - anything heavy lives in `disclosure`, mounted only while the sheet is
 *    open (Base UI unmounts the popup, so no portal DOM and no effects);
 *  - typography is fixed: 14px/medium title, 12px/muted description.
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
  const flat = surface === "sheet";

  const header = (
    <div className="flex items-start gap-3">
      {Icon ? (
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-secondary text-secondary-foreground shadow-elevation-sm">
          <Icon className="size-4" strokeWidth={2.2} aria-hidden />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium leading-5 tracking-tight text-foreground">
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
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
      {flat ? (
        <section className="space-y-3">
          {header}
          {body}
        </section>
      ) : (
        <Card
          className={cn(
            "gap-0 rounded-card border border-border bg-card py-0 shadow-elevation-sm",
            className,
          )}
          // 皮肤可通过 --mr-border-width / --mr-border-style 改变卡片质感。
          style={{
            borderWidth: "var(--mr-border-width)",
            borderStyle: "var(--mr-border-style)",
          }}
        >
          <div className="px-4 pt-4 sm:px-5">{header}</div>
          <div className="px-4 pb-4 pt-3 sm:px-5 sm:pb-5">{body}</div>
        </Card>
      )}
      {disclosure ? (
        <SettingsDetailSheet
          open={open}
          onOpenChange={setOpen}
          title={disclosure.title ?? title}
          description={disclosure.description ?? description}
        >
          {children}
        </SettingsDetailSheet>
      ) : null}
    </>
  );
}

/** Bordered list that owns the dividers for its rows. */
export function SettingsRowList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-background/60",
        className,
      )}
      style={{
        borderWidth: "var(--mr-border-width)",
        borderStyle: "var(--mr-border-style)",
      }}
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

/** A labelled row with a trailing control. Title 14px/medium, hint 12px/muted. */
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
        "flex min-h-12 flex-wrap items-center justify-between gap-3 px-3.5 py-2.5",
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
          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
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
 * The only sanctioned way to open a secondary surface: a full-width row with
 * a right chevron plus the current state as secondary text.
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
        "group/row flex w-full min-h-12 items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-accent/50 active:bg-accent/70",
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

/** Compact metric used in a status summary. */
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
          <span className="text-xs font-medium text-muted-foreground">{unit}</span>
        ) : null}
      </p>
    </div>
  );
}

export function SettingsStatRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-background/60 px-3.5 py-3 sm:grid-cols-4">
      {children}
    </div>
  );
}
