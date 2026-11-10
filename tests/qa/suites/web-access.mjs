/**
 * Web Access pairing UI harness (Issue #258).
 *
 * This suite drives the real desktop front-end through CDP, but replaces only
 * the `web_access_*` control-plane IPC calls with a deterministic in-page
 * fixture. It therefore exercises the actual React panel, countdown timers,
 * confirmation dialog, deny/cancel wiring and expiry convergence without
 * binding a LAN listener, generating certificates or pairing a real phone.
 *
 * Evidence level: automated DOM integration against the real UI bundle with
 * mocked control-plane responses. It is NOT a substitute for the L3 real
 * phone/TLS pairing run; that remains separately gated.
 */
import { fail, ok } from "../lib/report.mjs";

const INSTALL_MOCK = `(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") return false;
  if (window.__qaWebAccess) return true;
  const original = internals.invoke.bind(internals);
  const now = Date.now();
  const status = {
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
  };
  const claim = () => ({
    claimId: "claim_qa_1",
    deviceName: "Pixel QA",
    sourceIp: "192.168.1.44",
    createdAtUnixMs: now,
    expiresAtUnixMs: Date.now() + 20000,
  });
  const pairing = {
    window: {
      url: "https://192.168.1.10:7443/?pair=1#pair_" + "c".repeat(32),
      expiresAtUnixMs: now + 120000,
    },
    claims: [claim()],
  };
  const devices = [];
  const calls = [];
  const state = {
    status,
    pairing,
    devices,
    calls,
    claimId: "claim_qa_1",
    denied: null,
    approved: null,
  };
  const pairingState = () => ({
    window: state.pairing.window,
    // The backend prunes expired claims; emulate that on every snapshot so the
    // panel's local expiry -> refreshPairing() convergence can be asserted.
    claims: (state.pairing.claims || []).filter(
      (item) => item.expiresAtUnixMs > Date.now(),
    ),
  });
  const pendingCount = () => pairingState().claims.length;
  const api = {
    web_access_status: () => ({ ...state.status, pendingClaimCount: pendingCount() }),
    web_access_addresses: () => [{ ip: "192.168.1.10", interface: "Ethernet" }],
    web_access_pairing_state: () => {
      const snap = pairingState();
      state.status.pairingActive = snap.window !== null || snap.claims.length > 0;
      return snap;
    },
    web_access_pairing_start: () => {
      calls.push("pairing-start");
      state.pairing.window = {
        url: "https://192.168.1.10:7443/?pair=1#pair_" + "d".repeat(32),
        expiresAtUnixMs: Date.now() + 120000,
      };
      state.status.pairingActive = true;
      return state.pairing.window;
    },
    web_access_pairing_cancel: () => {
      calls.push("pairing-cancel");
      state.pairing.window = null;
      state.pairing.claims = [];
      state.status.pairingActive = false;
      state.status.pendingClaimCount = 0;
      return state.status;
    },
    web_access_pairing_deny: (_event, args) => {
      calls.push("deny:" + String(args && args.claimId));
      state.denied = String(args && args.claimId);
      state.pairing.claims = [];
      state.status.pendingClaimCount = 0;
      return state.status;
    },
    web_access_pairing_approve: (_event, args) => {
      calls.push("approve:" + String(args && args.claimId));
      state.approved = String(args && args.claimId);
      state.pairing.claims = [];
      state.status.pendingClaimCount = 0;
      state.status.deviceCount = 1;
      return state.status;
    },
    web_access_devices_list: () => state.devices,
    web_access_device_revoke: () => {
      state.devices = [];
      state.status.deviceCount = 0;
      return true;
    },
  };
  internals.invoke = async (command, args, options) => {
    if (Object.prototype.hasOwnProperty.call(api, command)) {
      calls.push(command);
      return api[command](command, args, options);
    }
    return original(command, args, options);
  };
  window.__qaWebAccess = state;
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
  window.__qaRestoreWebAccess = () => {
    internals.invoke = original;
    delete window.__qaWebAccess;
    delete window.__qaSetWebAccessClaim;
    delete window.__qaRestoreWebAccess;
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
  const installed = await page.eval(INSTALL_MOCK);
  if (!installed) {
    fail(report, {
      id: "web-access:mock-install",
      suite: "web-access",
      layer: "infrastructure",
      title: "无法安装 Web Access IPC 夹具",
      severity: "P0",
      details: "window.__TAURI_INTERNALS__.invoke 不可用",
      location: "tests/qa/suites/web-access.mjs",
    });
    return;
  }

  try {
    await ctx.goto("#/settings?tab=privacy");
    page = ctx.page;
    await page.waitFor(
      "!!document.querySelector('[data-testid=\"settings-web-access\"]') || !!document.querySelector('[data-testid=\"web-access-advanced\"]')",
      { timeout: 15000, label: "web access settings card" },
    );
    await page.eval(`(() => {
      const trigger = document.querySelector('[data-testid="web-access-advanced"]');
      if (trigger) trigger.click();
      return !!trigger;
    })()`);
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
    const approvedEarly = await page.eval("window.__qaWebAccess.approved");
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
    const denied = await page.eval("window.__qaWebAccess.denied");
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
    const calls = await page.eval("window.__qaWebAccess.calls.join(',')");
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
      const buttons = [...document.querySelectorAll("button")];
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
        stateCalls: window.__qaWebAccess.calls.filter((c) => c === "web_access_pairing_state").length,
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
  } finally {
    await ctx.page.eval("window.__qaRestoreWebAccess && window.__qaRestoreWebAccess()").catch(() => {});
  }
}
