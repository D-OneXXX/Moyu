/**
 * Web Access pairing UI harness (Issue #258).
 *
 * This suite drives the real desktop front-end through CDP. The Vite QA plugin
 * (`qaWebAccessFixturePlugin`) aliases only `src/features/web-access/api.ts` to
 * `tests/qa/lib/web-access-api-fixture.mjs`; the fixture delegates to the real
 * backend unless the suite installs `window.__QA_WEB_ACCESS__`. That keeps the
 * actual React panel, countdown timers, confirmation dialog, deny/cancel wiring
 * and expiry convergence under test without binding a LAN listener, creating
 * certificates, pairing a real phone, or replacing the Tauri IPC bridge.
 *
 * Evidence level: automated DOM integration against the real UI bundle with a
 * deterministic control-plane fixture. It is NOT a substitute for the L3 real
 * phone/TLS pairing run; that remains separately gated.
 */
import { fail, ok } from "../lib/report.mjs";

const SETUP_FIXTURE = `(() => {
  const now = Date.now();
  const claim = () => ({
    claimId: "claim_qa_1",
    deviceName: "Pixel QA",
    sourceIp: "192.168.1.44",
    createdAtUnixMs: now,
    // L3 下设置页加载/打开 disclosure 可能耗时十几秒；初始夹具必须活得
    // 足够久，否则 claim 会在面板首次拉取前被过滤，造成假失败。过期收敛
    // 另由 __qaSetWebAccessClaim(2) 覆盖。
    expiresAtUnixMs: now + 180000,
  });
  const state = {
    status: {
      phase: "enabled",
      transport: "https",
      bindAddress: "192.168.1.10",
      bindIp: "192.168.1.10",
      port: 7443,
      caInitialized: true,
      rootFingerprintSha256: "aa".repeat(32),
      leafFingerprintSha256: "bb".repeat(32),
      leafNotAfter: Math.floor(now / 1000) + 86400,
      certificateState: "valid",
      deviceCount: 0,
      pendingClaimCount: 1,
      pairingActive: true,
      lastErrorCode: null,
      stopReason: null,
    },
    pairing: {
      window: {
        url: "https://192.168.1.10:7443/?pair=1#pair_" + "c".repeat(32),
        expiresAtUnixMs: now + 300000,
      },
      claims: [claim()],
    },
    addresses: [
      // Virtual adapters are listed first on purpose: the automatic default
      // must still prefer the physical Ethernet address (Issue #337).
      { ip: "172.17.0.1", interface: "Docker Desktop" },
      { ip: "192.168.1.10", interface: "Ethernet" },
    ],
    devices: [],
    calls: [],
    lastStart: null,
    approved: null,
    denied: null,
  };
  window.__QA_WEB_ACCESS__ = state;
  window.__qaSetWebAccessClaim = (seconds) => {
    state.pairing.claims = [
      {
        claimId: "claim_qa_expiring",
        deviceName: "Tablet QA",
        sourceIp: "192.168.1.55",
        createdAtUnixMs: Date.now(),
        expiresAtUnixMs: Date.now() + Math.max(1, Number(seconds) || 2) * 1000,
      },
    ];
    state.status.pendingClaimCount = 1;
    return true;
  };
  return true;
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function failCheck(report, id, title, details, expected, actual, fix) {
  fail(report, {
    id,
    suite: "web-access",
    layer: "integration",
    title,
    severity: "P1",
    details,
    location: "src/components/settings/WebAccessPanel.tsx",
    expected,
    actual,
    rootCause: "Web Access 配对 UI 行为与 #258 契约不一致",
    fix,
  });
}

export async function runWebAccessSuite(ctx, report) {
  await ctx.setLocale("en");
  let page = ctx.page;
  await page.eval(
    `window.__TAURI_INTERNALS__.invoke("set_feature_enabled", { feature: "webAccess", enabled: true })`,
  );
  await page.eval(SETUP_FIXTURE);

  try {
    // Web Access 挂在「网络与在线源」分区，不是隐私分区；深链必须与
    // SettingsTab 的 network 分区一致，否则面板根本不会挂载。
    await ctx.goto("#/settings?tab=network");
    page = ctx.page;
    await page.waitFor(
      "!!document.querySelector('[data-testid=\"settings-tab-network\"]')",
      { timeout: 15000, label: "settings tabs" },
    );
    const fixtureActive = await page
      .waitFor("window.__QA_WEB_ACCESS_FIXTURE_ACTIVE__ === true", {
        timeout: 10000,
        label: "web access fixture active",
      })
      .then(() => true)
      .catch(() => false);
    if (!fixtureActive) {
      fail(report, {
        id: "web-access:fixture-inactive",
        suite: "web-access",
        layer: "infrastructure",
        title: "Web Access Vite 夹具未生效",
        severity: "P0",
        details:
          "面板没有调用夹具模块；QA 可能复用了未设置 MR_QA_WEB_ACCESS_FIXTURE=1 的普通 dev server。",
        location: "vite.config.ts",
        expected:
          "QA dev server 启用 qaWebAccessFixturePlugin 并加载 tests/qa/lib/web-access-api-fixture.mjs",
        actual: "window.__QA_WEB_ACCESS_FIXTURE_ACTIVE__ 未置位",
        fix: "停止复用中的 dev server，让 run-qa.mjs 启动自己的 Vite 实例",
      });
      return;
    }
    // 一级卡片只有摘要与「打开高级设置」入口；明细面板通过 disclosure
    // 放在居中弹窗里，关闭时不挂载，必须显式打开后才会出现
    // settings-web-access / claim 行。
    await page.waitFor(
      "!!document.querySelector('[data-testid=\"web-access-advanced\"]')",
      { timeout: 15000, label: "web access advanced trigger" },
    );
    await page.eval(`(() => {
      const trigger = document.querySelector('[data-testid="web-access-advanced"]');
      if (trigger) trigger.click();
      return !!trigger;
    })()`);
    await page.waitFor(
      "!!document.querySelector('[data-testid=\"settings-web-access\"]')",
      { timeout: 15000, label: "web access settings card" },
    );
    await page.waitFor(
      "!!document.querySelector('[data-testid=\"settings-web-access\"] [data-testid=\"web-access-claim-row\"]')",
      { timeout: 15000, label: "pending pairing claim" },
    );

    const claimSnapshot = await page.eval(`(() => {
      const row = document.querySelector('[data-testid="web-access-claim-row"]');
      const text = row ? row.textContent || "" : "";
      const countdown = row ? row.querySelector('[data-testid="web-access-claim-countdown"]') : null;
      return {
        text,
        claimId: row ? row.getAttribute("data-claim-id") : null,
        unverified: /Unverified name/i.test(text),
        sourceIp: text.includes("192.168.1.44"),
        countdown: countdown ? countdown.textContent || "" : "",
        tabular: countdown ? getComputedStyle(countdown).fontVariantNumeric || "" : "",
        classTabular: countdown ? countdown.className.includes("tabular-nums") : false,
      };
    })()`);
    if (
      !claimSnapshot.claimId ||
      !claimSnapshot.unverified ||
      !claimSnapshot.sourceIp ||
      !/Request expires in \d+s/.test(claimSnapshot.countdown) ||
      !(claimSnapshot.tabular.includes("tabular-nums") || claimSnapshot.classTabular)
    ) {
      failCheck(
        report,
        "web-access:claim-card",
        "待批准设备卡片缺少身份/风险/倒计时信息",
        JSON.stringify(claimSnapshot),
        "显示设备名、Unverified name 风险徽章、来源 IP、tabular-nums 倒计时",
        claimSnapshot.text.slice(0, 200),
        "恢复 ClaimRow 的风险徽章与 tabular-nums 倒计时",
      );
    } else {
      ok(report, {
        id: "web-access:claim-card",
        suite: "web-access",
        layer: "integration",
        title: "待批准设备卡片展示风险徽章、来源 IP 与 tabular-nums 倒计时",
        details: claimSnapshot.countdown,
      });
    }

    const firstSeconds = Number((claimSnapshot.countdown.match(/\d+/) || [0])[0]);
    await sleep(1300);
    const secondText = await page.eval(
      `document.querySelector('[data-testid="web-access-claim-countdown"]')?.textContent || ""`,
    );
    const secondSeconds = Number((secondText.match(/\d+/) || [0])[0]);
    if (!(firstSeconds > 0 && secondSeconds < firstSeconds)) {
      failCheck(
        report,
        "web-access:countdown-ticks",
        "配对请求倒计时未按秒递减",
        `${firstSeconds} -> ${secondSeconds}`,
        "1 秒后剩余秒数减少",
        secondText,
        "检查 useWebAccess 1s 本地计时器与 nowMs 更新",
      );
    } else {
      ok(report, {
        id: "web-access:countdown-ticks",
        suite: "web-access",
        layer: "integration",
        title: "配对请求倒计时按秒递减且不请求后端",
        details: `${firstSeconds}s -> ${secondSeconds}s`,
      });
    }

    // Approve opens the explicit risk confirmation; nothing is approved until
    // the user confirms inside that dialog.
    await page.eval(
      `document.querySelector('[data-testid="web-access-claim-approve"]')?.click(); true`,
    );
    await page.waitFor("!!document.querySelector('[role=\"alertdialog\"]')", {
      timeout: 8000,
      label: "approve confirmation dialog",
    });
    const dialog = await page.eval(`(() => {
      const node = document.querySelector('[role="alertdialog"]');
      return node ? node.textContent || "" : "";
    })()`);
    const approvedEarly = await page.eval("window.__QA_WEB_ACCESS__.approved");
    if (!/entire library and reading progress/i.test(dialog) || !/self-reported/i.test(dialog) || approvedEarly) {
      failCheck(
        report,
        "web-access:approve-risk",
        "批准确认框未展示权限风险，或未确认就提前批准",
        JSON.stringify({ dialog: dialog.slice(0, 300), approvedEarly }),
        "确认框说明可浏览整个书库/进度且设备名自报；确认前不调用 approve",
        dialog.slice(0, 300) || "no dialog",
        "恢复 approveConfirmMessage 与确认后调用 approve 的顺序",
      );
    } else {
      ok(report, {
        id: "web-access:approve-risk",
        suite: "web-access",
        layer: "integration",
        title: "批准前展示书库/进度权限风险且不会提前授权",
        details: "requires explicit confirmation",
      });
    }
    // Cancel the confirmation dialog (first pill button), then deny the claim.
    await page.eval(`(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const buttons = dialog ? [...dialog.querySelectorAll("button")] : [];
      if (buttons[0]) buttons[0].click();
      return true;
    })()`);
    await page.waitFor("!document.querySelector('[role=\"alertdialog\"]')", {
      timeout: 5000,
      label: "approve dialog closed",
    });

    await page.eval(
      `document.querySelector('[data-testid="web-access-claim-deny"]')?.click(); true`,
    );
    await page.waitFor(
      "!document.querySelector('[data-testid=\"web-access-claim-row\"]')",
      { timeout: 8000, label: "claim denied" },
    );
    const denied = await page.eval("window.__QA_WEB_ACCESS__.denied");
    if (denied !== "claim_qa_1") {
      failCheck(
        report,
        "web-access:deny",
        "拒绝按钮未调用对应 claim 的拒绝命令",
        String(denied),
        "web_access_pairing_deny(claim_qa_1)",
        String(denied),
        "保持 ClaimRow onDeny -> useWebAccess.deny(claimId) 绑定",
      );
    } else {
      ok(report, {
        id: "web-access:deny",
        suite: "web-access",
        layer: "integration",
        title: "拒绝请求只作用于对应 claim 并清空待批准列表",
        details: "claim_qa_1 denied",
      });
    }

    // Pairing window cancel -> start round-trip.
    await page.waitFor(
      "!!document.querySelector('[data-testid=\"web-access-claim-row\"]') === false",
      { timeout: 3000, label: "claims empty" },
    );
    await page.eval(`(() => {
      const buttons = [...document.querySelectorAll("button")];
      const cancel = buttons.find((b) => (b.textContent || "").trim() === "Cancel pairing");
      if (cancel) cancel.click();
      return !!cancel;
    })()`);
    await page.waitFor(
      `(() => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "Start pairing"))()`,
      { timeout: 8000, label: "pairing cancelled" },
    );
    await page.eval(`(() => {
      const buttons = [...document.querySelectorAll("button")];
      const start = buttons.find((b) => (b.textContent || "").trim() === "Start pairing");
      if (start) start.click();
      return !!start;
    })()`);
    await page.waitFor(
      "!!document.querySelector('[data-testid=\"web-access-pairing-countdown\"]')",
      { timeout: 8000, label: "pairing restarted" },
    );
    const calls = await page.eval("window.__QA_WEB_ACCESS__.calls.join(',')");
    if (!String(calls).includes("pairing-cancel") || !String(calls).includes("pairing-start")) {
      failCheck(
        report,
        "web-access:pairing-roundtrip",
        "取消配对/重新开始配对未落到后端命令",
        String(calls),
        "pairing-cancel 与 pairing-start 都被调用",
        String(calls),
        "检查 cancelPairing/startPairing 接线",
      );
    } else {
      ok(report, {
        id: "web-access:pairing-roundtrip",
        suite: "web-access",
        layer: "integration",
        title: "取消配对后可重新生成配对窗口",
        details: String(calls),
      });
    }

    // Expiry convergence: backend prunes the expired claim on the next
    // snapshot; the panel's local timer must trigger that refresh and clear
    // both the row and pending count without a manual reload.
    await page.eval("window.__qaSetWebAccessClaim(2)");
    await page.eval(`(() => {
      const panel = document.querySelector('[data-testid="settings-web-access"]');
      const buttons = panel ? [...panel.querySelectorAll("button")] : [];
      const refresh = buttons.find((b) => (b.textContent || "").includes("Refresh"));
      if (refresh) refresh.click();
      return !!refresh;
    })()`);
    await page.waitFor(
      "!!document.querySelector('[data-testid=\"web-access-claim-row\"]')",
      { timeout: 8000, label: "expiring claim shown" },
    );
    await sleep(3200);
    const expiry = await page.eval(`(() => {
      const row = document.querySelector('[data-testid="web-access-claim-row"]');
      const panel = document.querySelector('[data-testid="settings-web-access"]');
      const text = panel ? panel.textContent || "" : "";
      return {
        row: !!row,
        pendingZero:
          /Pending requests:\s*0/i.test(text) || /0 pending/i.test(text),
        stateCalls: window.__QA_WEB_ACCESS__.calls.filter(
          (name) => name === "web_access_pairing_state",
        ).length,
      };
    })()`);
    if (expiry.row || !expiry.pendingZero || expiry.stateCalls < 2) {
      failCheck(
        report,
        "web-access:expiry-convergence",
        "倒计时归零后待批准请求未自动收敛",
        JSON.stringify(expiry),
        "过期后 refreshPairing 自动调用，claim 行消失且待批准计数归零",
        JSON.stringify(expiry),
        "检查过期 effect 的 refreshPairing 调用与 pendingCount 计算",
      );
    } else {
      ok(report, {
        id: "web-access:expiry-convergence",
        suite: "web-access",
        layer: "integration",
        title: "倒计时归零后待批准请求自动收敛且计数归零",
        details: JSON.stringify(expiry),
      });
    }

    // Startup cancellation: while the listener is still starting, "Cancel
    // start" must route to the backend stop command instead of leaving a
    // half-bound service behind.
    await page.eval(`(() => {
      const state = window.__QA_WEB_ACCESS__;
      state.status.phase = "starting";
      state.status.bindAddress = null;
      state.status.port = null;
      const panel = document.querySelector('[data-testid="settings-web-access"]');
      const buttons = panel ? [...panel.querySelectorAll("button")] : [];
      const refresh = buttons.find((b) => (b.textContent || "").includes("Refresh"));
      if (refresh) refresh.click();
      return !!refresh;
    })()`);
    await page.waitFor(
      `(() => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "Cancel start"))()`,
      { timeout: 8000, label: "cancel start button" },
    );
    await page.eval(`(() => {
      const button = [...document.querySelectorAll("button")].find(
        (b) => (b.textContent || "").trim() === "Cancel start",
      );
      if (button) button.click();
      return !!button;
    })()`);
    await page.waitFor(
      `window.__QA_WEB_ACCESS__.calls.includes("stop")`,
      { timeout: 8000, label: "startup cancellation routed to stop" },
    );
    ok(report, {
      id: "web-access:cancel-start",
      suite: "web-access",
      layer: "integration",
      title: "启动中取消会调用后端 stop，不留半绑定监听",
      details: "Cancel start -> web_access_stop",
    });

    // Shared controller + preferred LAN address: the summary quick toggle must
    // start plain HTTP on the physical NIC (not the first Docker adapter), and
    // a stop performed inside the advanced dialog must immediately flip the
    // summary badge — proving both surfaces share one runtime snapshot.
    await page.key("Escape");
    await page.waitFor(
      "!document.querySelector('[data-testid=\"settings-web-access\"]')",
      { timeout: 8000, label: "advanced dialog closed" },
    );
    await page.eval(`(() => {
      document.querySelector('[data-testid="web-access-quick-toggle"]')?.click();
      return true;
    })()`);
    await page.waitFor(
      `window.__QA_WEB_ACCESS__.lastStart?.command === "web_access_start_plain"`,
      { timeout: 10000, label: "quick toggle starts plain" },
    );
    const quickStart = await page.eval(`(() => ({
      lastStart: window.__QA_WEB_ACCESS__.lastStart,
      phase: document.querySelector('[data-testid="web-access-summary-phase"]')?.textContent || "",
    }))()`);
    const preferredStart =
      quickStart.lastStart?.ip === "192.168.1.10" &&
      quickStart.lastStart?.command === "web_access_start_plain" &&
      /Enabled/i.test(quickStart.phase);
    if (!preferredStart) {
      failCheck(
        report,
        "web-access:preferred-ip",
        "快速开启未选中物理网卡或未走普通 HTTP 模式",
        JSON.stringify(quickStart),
        "web_access_start_plain(192.168.1.10) 且摘要显示 Enabled",
        JSON.stringify(quickStart),
        "使用 pickPreferredLanAddress 过滤 Docker/WSL 等虚拟网卡后启动",
      );
    } else {
      ok(report, {
        id: "web-access:preferred-ip",
        suite: "web-access",
        layer: "integration",
        title: "未手选 IP 时优先使用物理网卡并走普通 HTTP",
        details: JSON.stringify(quickStart.lastStart),
      });
    }

    await page.eval(
      `document.querySelector('[data-testid="web-access-advanced"]')?.click(); true`,
    );
    await page.waitFor(
      "!!document.querySelector('[data-testid=\"settings-web-access\"]')",
      { timeout: 10000, label: "advanced panel reopened" },
    );
    await page.eval(
      `document.querySelector('[data-testid="web-access-stop"]')?.click(); true`,
    );
    await page.waitFor("!!document.querySelector('[role=\"alertdialog\"]')", {
      timeout: 8000,
      label: "stop confirmation",
    });
    await page.eval(`(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const buttons = dialog ? [...dialog.querySelectorAll("button")] : [];
      const confirm = buttons.find((button) => /Stop service/i.test(button.textContent || ""));
      confirm?.click();
      return !!confirm;
    })()`);
    await page.waitFor(
      `window.__QA_WEB_ACCESS__.status.phase === "disabled"`,
      { timeout: 10000, label: "advanced stop applied" },
    );
    const syncedStop = await page.eval(`(() => ({
      phase: document.querySelector('[data-testid="web-access-summary-phase"]')?.textContent || "",
      fixture: window.__QA_WEB_ACCESS__.status.phase,
    }))()`);
    if (syncedStop.fixture !== "disabled" || !/Disabled/i.test(syncedStop.phase)) {
      failCheck(
        report,
        "web-access:shared-state-sync",
        "高级面板停止后摘要卡状态未同步",
        JSON.stringify(syncedStop),
        "两个面板共享同一控制器，摘要立即显示 Disabled",
        JSON.stringify(syncedStop),
        "由 WebAccessProvider 提供单一 useWebAccess 控制器，禁止各面板各自开流",
      );
    } else {
      ok(report, {
        id: "web-access:shared-state-sync",
        suite: "web-access",
        layer: "integration",
        title: "摘要卡与高级面板共享启停状态（停止即时同步）",
        details: JSON.stringify(syncedStop),
      });
    }
  } finally {
    await ctx.page
      .eval(`(() => {
        delete window.__QA_WEB_ACCESS__;
        delete window.__QA_WEB_ACCESS_FIXTURE_ACTIVE__;
        delete window.__qaSetWebAccessClaim;
        return true;
      })()`)
      .catch(() => {});
  }
}
