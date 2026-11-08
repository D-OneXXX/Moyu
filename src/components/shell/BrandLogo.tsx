import AppBrandIcon from "./AppBrandIcon";

/**
 * 导航栏品牌标识：0.19.1 原版徽章 + Moyu 字标。
 *
 * 图标是固定绘制的原版图形（固定配色，不随主题漂移），也不读取任何偏好：
 * 应用图标的可替换能力只作用在桌面快捷方式 / 任务栏 / 托盘等系统级图标上，
 * 主界面左上角永远保持 0.19.1 发布版的原样。
 */
export default function BrandLogo() {
  return (
    <div className="flex select-none items-center gap-2.5">
      <AppBrandIcon
        selection={{ kind: "preset", preset: "moyu" }}
        className="transition-transform duration-150 hover:scale-105"
      />
      <span className="text-lg font-extrabold tracking-wider text-foreground">
        Mo<span className="text-primary">yu</span>
      </span>
    </div>
  );
}
