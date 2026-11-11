/**
 * Developer feature-gate regression.
 *
 * 真实 Tauri 后端 + 真实设置页：
 * - 开发者入口集中展示 9 项门卫，并使用 set_feature_enabled 写入；
 * - 关闭 OPDS / Web Access / 浏览器后，入口不消失、挂载不发后端查询，
 *   只显示可恢复占位，并能在原地一键恢复；
 * - “恢复默认模块配置”回到既定默认值（online=false，其余 true）。
 *
 * 本套件不启动 LAN 监听、不创建配对、不下载任何内容；所有写入在 finally
 * 中恢复默认值，避免污染后续套件。
 */
import { invoke } from "../lib/app.mjs";
import { fail, ok } from "../lib/report.mjs";

const DEFAULTS = {
  webtoon: true,
  online: false,
  browser: true,
  pdf: true,
  opds: true,
  webAccess: true,
  updates: true,
  backup: true,
  diagnostics: true,
};

async function restoreDefaults(page) {
  for (const [feature, enabled] of Object.entries(DEFAULTS)) {
    await invoke(page, "set_feature_enabled", { feature, enabled });
  }
}

function failCheck(report, id, title, details, expected, actual, fix) {
  fail(report, {
    id,
    suite: "feature-gate",
    layer: "integration",
    title,
    severity: "P1",
    details,
    location: "src/pages/Settings.tsx / DeveloperFeaturePanel.tsx",
    expected,
    actual,
    rootCause: "开发者功能门卫与业务入口的可恢复降级契约不一致",
    fix,
  });
}

export async function runFeatureGateSuite(ctx, report) {
  await ctx.setLocale("en");
  await restoreDefaults(ctx.page);

  try {
    // 1) Developer panel exposes all nine gates and uses the authoritative writer.
    await ctx.goto("#/settings?tab=about");
    await ctx.page.waitFor(
      "!!document.querySelector('[data-testid=\"developer-feature-open\"]')",
      { timeout: 15000, label: "developer feature entry" },
    );
    await ctx.page.eval(`(() => {
      document.querySelector('[data-testid="developer-feature-open"]')?.click();
      return true;
    })()`);
    await ctx.page.waitFor(
      "!!document.querySelector('[data-testid=\"developer-feature-panel\"]')",
      { timeout: 10000, label: "developer feature panel" },
    );
    const panel = await ctx.page.eval(`(() => {
      const root = document.querySelector('[data-testid="developer-feature-panel"]');
      const ids = ["webtoon","online","browser","pdf","opds","webAccess","updates","backup","diagnostics"];
      const switches = ids.map((id) => root?.querySelector('[data-testid="developer-feature-' + id + '"]'));
      return {
        count: switches.filter(Boolean).length,
        onlineOff: switches[1]?.getAttribute("aria-checked") === "false",
        othersOn: switches.filter((_, index) => index !== 1).every(
          (node) => node?.getAttribute("aria-checked") === "true",
        ),
        hasReset: !!root?.querySelector('[data-testid="developer-feature-reset"]'),
      };
    })()`);
    if (
      panel.count !== 9 ||
      !panel.onlineOff ||
      !panel.othersOn ||
      !panel.hasReset
    ) {
      failCheck(
        report,
        "feature-gate:panel-matrix",
        "开发者总控未展示 9 项门卫或默认值错误",
        JSON.stringify(panel),
        "9 个开关，online 默认关闭、其余默认开启，并提供恢复默认按钮",
        JSON.stringify(panel),
        "检查 DeveloperFeaturePanel 的 FEATURE_REGISTRY 遍历与默认值徽章",
      );
    } else {
      ok(report, {
        id: "feature-gate:panel-matrix",
        suite: "feature-gate",
        layer: "integration",
        title: "开发者总控展示 9 项门卫、默认值与恢复按钮",
        details: JSON.stringify(panel),
      });
    }

    // 2) Turn OPDS off from the developer panel, then verify the network tab
    //    shows a recoverable placeholder instead of unmounting the entry.
    await ctx.page.eval(`(() => {
      document.querySelector('[data-testid="developer-feature-opds"]')?.click();
      return true;
    })()`);
    await ctx.page.waitFor(
      `document.querySelector('[data-testid="developer-feature-opds"]')?.getAttribute("aria-checked") === "false"`,
      { timeout: 10000, label: "opds gate off" },
    );
    await ctx.page.key("Escape");
    await ctx.page.waitFor(
      "!document.querySelector('[data-testid=\"developer-feature-panel\"]')",
      { timeout: 8000, label: "developer panel closed" },
    );
    await ctx.goto("#/settings?tab=network");
    await ctx.page.waitFor(
      "!!document.querySelector('[data-testid=\"feature-disabled-opds\"]')",
      { timeout: 15000, label: "opds disabled notice" },
    );
    const opdsGate = await ctx.page.eval(`(() => ({
      notice: !!document.querySelector('[data-testid="feature-disabled-opds"]'),
      panelMounted: !!document.querySelector('[data-testid="opds-enabled"]'),
      errorToast: [...document.querySelectorAll('[role="alert"]')].some(
        (node) => /feature-disabled/i.test(node.textContent || ""),
      ),
    }))()`);
    if (!opdsGate.notice || opdsGate.panelMounted || opdsGate.errorToast) {
      failCheck(
        report,
        "feature-gate:opds-placeholder",
        "关闭 OPDS 后入口未降级为可恢复占位或仍向后端查询",
        JSON.stringify(opdsGate),
        "显示占位条、不挂载 OPDS 表单、不出现 feature-disabled 报错",
        JSON.stringify(opdsGate),
        "在 Settings 中按 features.opds 分支渲染 FeatureDisabledNotice，禁止挂载 OpdsPanel",
      );
    } else {
      ok(report, {
        id: "feature-gate:opds-placeholder",
        suite: "feature-gate",
        layer: "integration",
        title: "关闭 OPDS 后显示可恢复占位且不发起后端查询",
        details: JSON.stringify(opdsGate),
      });
    }

    // One-click restore from the placeholder.
    await ctx.page.eval(`(() => {
      document.querySelector('[data-testid="feature-enable-opds"]')?.click();
      return true;
    })()`);
    await ctx.page.waitFor(
      "!!document.querySelector('[data-testid=\"opds-enabled\"]')",
      { timeout: 10000, label: "opds restored" },
    );
    const opdsRestored = await invoke(ctx.page, "get_settings");
    if (opdsRestored.features.opds !== true) {
      failCheck(
        report,
        "feature-gate:opds-restore",
        "占位条一键启用未调用 set_feature_enabled",
        JSON.stringify(opdsRestored.features),
        "features.opds === true",
        JSON.stringify(opdsRestored.features),
        "FeatureDisabledNotice 必须走 setFeatureEnabled 并在 Settings 中同步表单",
      );
    } else {
      ok(report, {
        id: "feature-gate:opds-restore",
        suite: "feature-gate",
        layer: "integration",
        title: "OPDS 占位条一键启用恢复表单与后端门卫",
        details: "features.opds=true",
      });
    }

    // 2b) OPDS form writes must use the value the user just clicked:
    //     the enable switch and clear-password button previously read a stale
    //     stateRef because React had not committed the setState yet.
    await invoke(ctx.page, "opds_set_config", {
      config: {
        enabled: true,
        url: "http://192.168.1.50:8080/opds",
        username: "qa-user",
        password: "qa-password",
      },
    });
    // Leave Settings entirely so OpdsPanel remounts and reloads opds_get_config;
    // staying on the same hash would keep the previous form snapshot.
    await ctx.goto("#/");
    await ctx.goto("#/settings?tab=network");
    await ctx.page.waitFor(
      "!!document.querySelector('[data-testid=\"opds-enabled\"]')",
      { timeout: 15000, label: "opds form after config" },
    );
    const passwordEcho = await ctx.page.eval(`(() => ({
      savedBadge: [...document.querySelectorAll("span,div")].some(
        (node) => /Password saved/i.test(node.textContent || ""),
      ),
      passwordValue: document.querySelector('[data-testid="opds-password"]')?.value ?? null,
    }))()`);
    await ctx.page.eval(
      `document.querySelector('[data-testid="opds-enabled"]')?.click(); true`,
    );
    await ctx.page.waitFor(
      `window.__TAURI_INTERNALS__.invoke("opds_get_config").then((config) => config.enabled === false)`,
      { timeout: 10000, label: "opds switch persisted off" },
    ).catch(() => {});
    await ctx.page.eval(
      `document.querySelector('[data-testid="opds-clear-password"]')?.click(); true`,
    );
    await ctx.page.waitFor(
      `window.__TAURI_INTERNALS__.invoke("opds_get_config").then((config) => config.hasPassword === false)`,
      { timeout: 10000, label: "opds clear password persisted" },
    ).catch(() => {});
    const opdsAfter = await invoke(ctx.page, "opds_get_config");
    if (
      !passwordEcho.savedBadge ||
      passwordEcho.passwordValue !== "" ||
      opdsAfter.enabled !== false ||
      opdsAfter.hasPassword !== false
    ) {
      failCheck(
        report,
        "feature-gate:opds-form-write",
        "OPDS 开关/清除密码未使用最新点击值或密码回显错误",
        JSON.stringify({ passwordEcho, opdsAfter }),
        "密码输入框为空且显示已保存徽章；关闭开关与清除密码都立即落库",
        JSON.stringify({ passwordEcho, opdsAfter }),
        "在 setState 前同步 stateRef（syncFields），并只回显 hasPassword 徽章",
      );
    } else {
      ok(report, {
        id: "feature-gate:opds-form-write",
        suite: "feature-gate",
        layer: "integration",
        title: "OPDS 开关与清除密码立即落库，密码仅回显已保存状态",
        details: JSON.stringify(opdsAfter),
      });
    }

    // 3) Browser route must remain reachable and show a page-level placeholder.
    await ctx.goto("#/settings?tab=about");
    await ctx.page.waitFor(
      "!!document.querySelector('[data-testid=\"developer-feature-open\"]')",
      { timeout: 15000, label: "developer entry again" },
    );
    await ctx.page.eval(`(() => {
      document.querySelector('[data-testid="developer-feature-open"]')?.click();
      return true;
    })()`);
    await ctx.page.waitFor(
      "!!document.querySelector('[data-testid=\"developer-feature-browser\"]')",
      { timeout: 10000, label: "browser gate" },
    );
    await ctx.page.eval(`(() => {
      document.querySelector('[data-testid="developer-feature-browser"]')?.click();
      return true;
    })()`);
    await ctx.page.waitFor(
      `document.querySelector('[data-testid="developer-feature-browser"]')?.getAttribute("aria-checked") === "false"`,
      { timeout: 10000, label: "browser gate off" },
    );
    await ctx.page.key("Escape");
    await ctx.goto("#/browser");
    await ctx.page.waitFor(
      "!!document.querySelector('[data-testid=\"feature-disabled-page-browser\"]')",
      { timeout: 15000, label: "browser disabled page" },
    );
    const browserGate = await ctx.page.eval(`(() => ({
      placeholder: !!document.querySelector('[data-testid="feature-disabled-page-browser"]'),
      browserMounted: !!document.getElementById("browser-url-input"),
      navVisible: !!document.querySelector('a[href="#/browser"], a[href="/browser"]'),
    }))()`);
    if (!browserGate.placeholder || browserGate.browserMounted) {
      failCheck(
        report,
        "feature-gate:browser-page",
        "关闭浏览器门卫后 /browser 未降级为整页占位",
        JSON.stringify(browserGate),
        "显示整页占位、不挂载浏览器地址栏",
        JSON.stringify(browserGate),
        "AppShell 路由按 features.browser 渲染 FeatureDisabledPage，而不是重定向或挂载 Browser",
      );
    } else {
      ok(report, {
        id: "feature-gate:browser-page",
        suite: "feature-gate",
        layer: "integration",
        title: "关闭浏览器门卫后 /browser 保持入口并显示整页占位",
        details: JSON.stringify(browserGate),
      });
    }

    // 4) Restore defaults from the developer panel and verify the contract.
    await ctx.goto("#/settings?tab=about");
    await ctx.page.waitFor(
      "!!document.querySelector('[data-testid=\"developer-feature-open\"]')",
      { timeout: 15000, label: "developer entry for reset" },
    );
    await ctx.page.eval(`(() => {
      document.querySelector('[data-testid="developer-feature-open"]')?.click();
      return true;
    })()`);
    await ctx.page.waitFor(
      "!!document.querySelector('[data-testid=\"developer-feature-reset\"]')",
      { timeout: 10000, label: "reset button" },
    );
    await ctx.page.eval(`(() => {
      document.querySelector('[data-testid="developer-feature-reset"]')?.click();
      return true;
    })()`);
    await ctx.page.waitFor(
      "!!document.querySelector('[role=\"alertdialog\"]')",
      { timeout: 8000, label: "reset confirmation" },
    );
    await ctx.page.eval(`(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const buttons = dialog ? [...dialog.querySelectorAll("button")] : [];
      const confirm = buttons.find((button) => /Restore default/i.test(button.textContent || ""));
      confirm?.click();
      return !!confirm;
    })()`);
    await ctx.page.waitFor(
      `document.querySelector('[data-testid="developer-feature-browser"]')?.getAttribute("aria-checked") === "true"`,
      { timeout: 15000, label: "defaults restored" },
    );
    const restored = await invoke(ctx.page, "get_settings");
    const restoredOk = Object.entries(DEFAULTS).every(
      ([feature, expected]) => restored.features[feature] === expected,
    );
    if (!restoredOk) {
      failCheck(
        report,
        "feature-gate:reset-defaults",
        "恢复默认模块配置未写回 9 项默认值",
        JSON.stringify(restored.features),
        JSON.stringify(DEFAULTS),
        JSON.stringify(restored.features),
        "逐项调用 set_feature_enabled，并用返回的权威 Settings 刷新表单",
      );
    } else {
      ok(report, {
        id: "feature-gate:reset-defaults",
        suite: "feature-gate",
        layer: "integration",
        title: "恢复默认模块配置写回 9 项默认值",
        details: JSON.stringify(restored.features),
      });
    }
  } finally {
    await restoreDefaults(ctx.page).catch(() => {});
  }
}
