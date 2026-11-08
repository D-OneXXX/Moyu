import { useEffect, type RefObject } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const STORAGE_KEY = "mr-scroll-positions";
const RESTORE_FLAG_KEY = "mr-scroll-restore";

type Positions = Record<string, number>;

/**
 * Asks the next shell mount to restore `pathname`'s scroll offset even though
 * the navigation is a PUSH. The reader uses this on "back to library": the
 * shell was unmounted while reading, so `POP` semantics never apply.
 */
export function requestScrollRestore(pathname: string): void {
  try {
    sessionStorage.setItem(RESTORE_FLAG_KEY, pathname);
  } catch {
    /* Private mode: fall back to top-of-page. */
  }
}

function consumeRestoreRequest(pathname: string): boolean {
  try {
    if (sessionStorage.getItem(RESTORE_FLAG_KEY) !== pathname) return false;
    sessionStorage.removeItem(RESTORE_FLAG_KEY);
    return true;
  } catch {
    return false;
  }
}

function readPositions(): Positions {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const result: Positions = {};
    for (const [key, value] of Object.entries(parsed as Positions)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistPositions(positions: Positions): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    /* Private mode: restore still works within the current session. */
  }
}

/**
 * Keeps the shell scroll container's position per pathname.
 *
 * The reader route unmounts `<AppShell>` entirely, so an in-memory map is not
 * enough: positions are mirrored into `sessionStorage` and survive the
 * round-trip to `/reader/:id`. Back/forward (`POP`) restores; a fresh push
 * starts at the top, which matches native desktop expectations.
 */
export function useScrollRestoration<T extends HTMLElement>(
  ref: RefObject<T | null>,
): void {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();

  // Record the outgoing position (rAF-throttled, persisted on a short debounce).
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const positions = readPositions();
    let frame = 0;
    let timer = 0;

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        positions[pathname] = node.scrollTop;
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => persistPositions(positions), 180);
      });
    };

    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
      persistPositions(positions);
    };
  }, [pathname, ref]);

  // Restore on POP (or an explicit reader → library return), reset otherwise.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const explicit = consumeRestoreRequest(pathname);
    if (!explicit && navigationType !== "POP") {
      node.scrollTo({ top: 0, left: 0, behavior: "auto" });
      const positions = readPositions();
      if (positions[pathname] !== undefined) {
        delete positions[pathname];
        persistPositions(positions);
      }
      return;
    }

    const target = readPositions()[pathname] ?? 0;
    if (target <= 0) return;

    let cancelled = false;
    let frame = 0;
    const deadline = performance.now() + 900;

    const attempt = () => {
      if (cancelled) return;
      node.scrollTop = target;
      // The list may still be loading; retry until the content can actually
      // hold the offset, then stop instead of fighting the user's scroll.
      const satisfied =
        Math.abs(node.scrollTop - target) < 2 ||
        node.scrollHeight >= target + node.clientHeight;
      if (!satisfied && performance.now() < deadline) {
        frame = requestAnimationFrame(attempt);
      }
    };

    frame = requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
    };
  }, [navigationType, pathname, ref]);
}
