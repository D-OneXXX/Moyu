/**
 * 品牌展示名的唯一事实源。
 *
 * 原生窗口标题、文档标题与守卫脚本都读这里：品牌文案一旦漂移，
 * `static:release-surface` 守卫会立刻失败，而不是等到发版才发现。
 */
export const BRAND_DISPLAY_NAME = "Moyu";
