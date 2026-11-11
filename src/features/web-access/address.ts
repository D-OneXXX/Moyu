import type { LanAddressView } from "./types";

const VIRTUAL_INTERFACE = /(docker|veth|br-|virbr|vmnet|vboxnet|vethernet|hyper-v|wsl|tailscale|zerotier|utun|tap|tun|loopback)/i;
const PHYSICAL_INTERFACE = /^(wi-?fi|wlan|wireless|ethernet|eth\d|en\d|enp|eno|enx|wlp|wlan\d)/i;

/** 0 = 物理网卡，1 = 未知，2 = 明确的虚拟/隧道网卡。 */
function interfacePriority(name: string): number {
  const normalized = name.trim();
  if (VIRTUAL_INTERFACE.test(normalized)) return 2;
  if (PHYSICAL_INTERFACE.test(normalized)) return 0;
  return 1;
}

/** 常见家庭/办公室网段优先于容器桥接常用的 172.16/12。 */
function subnetPriority(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

/**
 * 默认监听地址：物理网卡 > 未知网卡 > 虚拟网卡；同层再按常见私有网段排序。
 *
 * 后端 `web_access_addresses` 也会做同样排序；前端再算一次是为了兼容
 * QA 夹具以及后端遗漏的新虚拟网卡命名，保证“未手选 IP 直接点开启”不会
 * 默认落到 WSL/Docker 的 172.x 桥接地址。
 */
export function pickPreferredLanAddress(
  addresses: readonly LanAddressView[],
): string | null {
  let best: LanAddressView | null = null;
  let bestScore: [number, number, string] | null = null;
  for (const address of addresses) {
    const ip = address.ip.trim();
    if (!ip) continue;
    const score: [number, number, string] = [
      interfacePriority(address.interface),
      subnetPriority(ip),
      ip,
    ];
    if (
      bestScore === null ||
      score[0] < bestScore[0] ||
      (score[0] === bestScore[0] &&
        (score[1] < bestScore[1] ||
          (score[1] === bestScore[1] && score[2] < bestScore[2])))
    ) {
      best = address;
      bestScore = score;
    }
  }
  return best?.ip ?? null;
}
