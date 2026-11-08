import { useLocation } from "react-router-dom";
import { useSkin } from "@/features/skin/SkinProvider";
import { resolveSkinAssetUrl } from "@/features/skin/registry";
import { SKIN_SLOT_IDS, type SkinDecoration } from "@/features/skin/types";

/**
 * Renders the active skin's decorations into the four fixed slots.
 *
 * Rules baked into this component (Task 7 contract):
 *  - the layer itself is `pointer-events: none` and never intercepts a click,
 *    a scrollbar drag or a top-bar hit; only `interactive` artwork opts in;
 *  - the layer is a sibling of the page content, not a wrapper, so it cannot
 *    affect layout or scroll height;
 *  - immersive reading unmounts it completely (zero DOM, zero memory);
 *  - safe mode hides it through CSS (see index.css).
 */
export default function ThemeDecorationLayer() {
  const { decorations } = useSkin();
  const { pathname } = useLocation();

  // AppShell is not mounted for /reader/:id, but keep the invariant local so a
  // future layout refactor cannot leak a mascot into the reading surface.
  if (pathname.startsWith("/reader/")) return null;
  if (decorations.length === 0) return null;

  return (
    <div className="mr-decoration-layer" data-testid="theme-decoration-layer">
      {SKIN_SLOT_IDS.map((slot) => {
        const slotDecorations = decorations.filter(
          (decoration) => decoration.slot === slot,
        );
        if (slotDecorations.length === 0) return null;
        return (
          <div key={slot} className="mr-decoration-slot" data-slot={slot}>
            {slotDecorations.map((decoration) => (
              <DecorationArtwork key={decoration.id} decoration={decoration} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function DecorationArtwork({ decoration }: { decoration: SkinDecoration }) {
  const src = resolveSkinAssetUrl(decoration.asset.src);
  if (!src) return null;
  const frame = decoration.slot === "window-frame-surround";
  return (
    <img
      src={src}
      alt={decoration.alt ?? ""}
      aria-hidden={decoration.alt ? undefined : true}
      draggable={false}
      decoding="async"
      data-interactive={decoration.interactive ? "true" : "false"}
      data-motion={decoration.asset.motion ?? "none"}
      className={frame ? "mr-decoration size-full" : "mr-decoration"}
      style={
        frame
          ? { objectFit: "fill" }
          : { height: decoration.asset.sizePx ?? 96, width: "auto" }
      }
    />
  );
}
