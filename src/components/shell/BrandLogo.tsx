import AppBrandIcon from "./AppBrandIcon";

/**
 * 导航栏品牌标识：0.19.1 原版徽章 + Moyu 字标。
 *
 * 徽章是固定绘制的原版图形（固定配色，不随主题漂移），也不读取任何偏好：
 * 图标不存在替换入口，系统级图标恒为随包构建资源。
 */
export default function BrandLogo() {
  return (
    <div className="flex select-none items-center gap-2.5">
      <AppBrandIcon className="size-8 shrink-0 transition-transform duration-150 hover:scale-105" />
      <span className="text-lg font-extrabold tracking-wider text-foreground">
        Mo<span className="text-primary">yu</span>
      </span>
    </div>
  );
}
