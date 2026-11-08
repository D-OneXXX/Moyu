import AppBrandIcon from "./AppBrandIcon";

/**
 * 导航栏品牌标识：可切换 brand icon + Moyu 字标。
 * 图标由 `AppBrandIcon` 按设置中的预设/自定义偏好渲染。
 */
export default function BrandLogo() {
  return (
    <div className="flex select-none items-center gap-2.5">
      <AppBrandIcon className="transition-transform duration-150 hover:scale-105" />
      <span className="text-lg font-extrabold tracking-wider text-foreground">
        Mo<span className="text-primary">yu</span>
      </span>
    </div>
  );
}
