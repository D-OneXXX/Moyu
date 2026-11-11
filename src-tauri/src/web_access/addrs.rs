use std::net::Ipv4Addr;

use super::error::{WebAccessError, WebAccessResult};

/// Maximum number of IPv4 SANs the CA accepts per leaf.
const MAX_SAN_IPS: usize = 8;

/// Interface names that are almost always virtual bridges/tunnels. They stay
/// selectable, but must never win the automatic default over a physical NIC.
const VIRTUAL_INTERFACE_HINTS: [&str; 16] = [
    "docker",
    "veth",
    "br-",
    "virbr",
    "vmnet",
    "vboxnet",
    "virtualbox",
    "vmware",
    "vethernet",
    "hyper-v",
    "wsl",
    "tailscale",
    "zerotier",
    "utun",
    "loopback",
    "tap",
];

const PHYSICAL_INTERFACE_PREFIXES: [&str; 10] = [
    "wi-fi", "wifi", "wlan", "wireless", "ethernet", "eth", "en", "wlp", "eno", "enp",
];

/// 0 = physical NIC, 1 = unknown, 2 = explicit virtual/tunnel adapter.
fn interface_priority(name: &str) -> u8 {
    let normalized = name.trim().to_ascii_lowercase();
    if VIRTUAL_INTERFACE_HINTS
        .iter()
        .any(|hint| normalized.contains(hint))
    {
        return 2;
    }
    if PHYSICAL_INTERFACE_PREFIXES
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
    {
        return 0;
    }
    1
}

/// Typical home/office subnets rank before container/bridge 172.16/12.
fn subnet_priority(ip: Ipv4Addr) -> u8 {
    let octets = ip.octets();
    if octets[0] == 192 && octets[1] == 168 {
        0
    } else if octets[0] == 10 {
        1
    } else if octets[0] == 172 && (16..=31).contains(&octets[1]) {
        2
    } else {
        3
    }
}

fn preferred_order(left: &LanAddress, right: &LanAddress) -> std::cmp::Ordering {
    interface_priority(&left.interface)
        .cmp(&interface_priority(&right.interface))
        .then_with(|| subnet_priority(left.ip).cmp(&subnet_priority(right.ip)))
        .then_with(|| left.ip.cmp(&right.ip))
        .then_with(|| left.interface.cmp(&right.interface))
}

/// A LAN SAN must be a usable RFC 1918 IPv4 address. Loopback, link-local,
/// unspecified, broadcast, multicast and public addresses are rejected.
pub fn is_private_lan_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_unspecified()
        && !ip.is_broadcast()
        && !ip.is_multicast()
        && (octets[0] == 10
            || (octets[0] == 172 && (16..=31).contains(&octets[1]))
            || (octets[0] == 192 && octets[1] == 168))
}

/// A currently usable private IPv4 address and its OS interface name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LanAddress {
    pub ip: Ipv4Addr,
    pub interface: String,
}

/// Enumerate the current non-loopback RFC 1918 IPv4 addresses together with
/// their interface names. The caller enforces the leaf SAN cap; the desktop UI
/// uses the names only for display.
pub(crate) fn local_lan_addresses() -> WebAccessResult<Vec<LanAddress>> {
    let interfaces = if_addrs::get_if_addrs().map_err(WebAccessError::Io)?;
    let mut addresses = interfaces
        .into_iter()
        .filter_map(|interface| match interface.addr {
            if_addrs::IfAddr::V4(v4) if is_private_lan_ipv4(v4.ip) => Some(LanAddress {
                ip: v4.ip,
                interface: interface.name,
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    addresses.sort_by(preferred_order);
    addresses.dedup();
    if addresses.is_empty() {
        return Err(WebAccessError::NoLanAddress);
    }
    Ok(addresses)
}

/// Enumerate the current non-loopback RFC 1918 IPv4 addresses. The caller is
/// responsible for enforcing the leaf SAN cap when using this directly;
/// [`select_san_ips`] does so.
pub fn local_private_ipv4s() -> WebAccessResult<Vec<Ipv4Addr>> {
    let mut ips = local_lan_addresses()?
        .into_iter()
        .map(|address| address.ip)
        .collect::<Vec<_>>();
    ips.sort();
    ips.dedup();
    Ok(ips)
}

/// Resolve the SAN list used for a leaf. `None` enumerates the current LAN
/// addresses; `Some` is an explicit list (used by tests and future callers).
/// The result is sorted, deduplicated and limited to 1..=8 addresses.
pub fn select_san_ips(provided: Option<Vec<Ipv4Addr>>) -> WebAccessResult<Vec<Ipv4Addr>> {
    let mut ips = match provided {
        Some(ips) => ips,
        None => local_private_ipv4s()?,
    };
    if let Some(invalid) = ips.iter().find(|ip| !is_private_lan_ipv4(**ip)) {
        return Err(WebAccessError::InvalidSan(*invalid));
    }
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        return Err(WebAccessError::NoLanAddress);
    }
    if ips.len() > MAX_SAN_IPS {
        return Err(WebAccessError::TooManyLanAddresses);
    }
    Ok(ips)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lan(ip: &str, interface: &str) -> LanAddress {
        LanAddress {
            ip: ip.parse().unwrap(),
            interface: interface.to_owned(),
        }
    }

    #[test]
    fn private_lan_filter_rejects_non_rfc1918_and_special_addresses() {
        assert!(is_private_lan_ipv4("192.168.1.20".parse().unwrap()));
        assert!(is_private_lan_ipv4("10.0.0.4".parse().unwrap()));
        assert!(is_private_lan_ipv4("172.16.5.1".parse().unwrap()));
        assert!(!is_private_lan_ipv4("127.0.0.1".parse().unwrap()));
        assert!(!is_private_lan_ipv4("169.254.1.1".parse().unwrap()));
        assert!(!is_private_lan_ipv4("100.64.0.1".parse().unwrap()));
        assert!(!is_private_lan_ipv4("8.8.8.8".parse().unwrap()));
        assert!(!is_private_lan_ipv4("0.0.0.0".parse().unwrap()));
    }

    #[test]
    fn physical_interface_beats_virtual_even_on_172_network() {
        assert_eq!(interface_priority("Wi-Fi"), 0);
        assert_eq!(interface_priority("Ethernet"), 0);
        assert_eq!(interface_priority("vEthernet (WSL)"), 2);
        assert_eq!(interface_priority("Docker Desktop"), 2);
        assert_eq!(interface_priority("br-7d2a"), 2);
        assert_eq!(interface_priority("未知网卡"), 1);
    }

    #[test]
    fn preferred_order_puts_physical_home_lan_first() {
        let mut addresses = vec![
            lan("172.17.0.1", "Docker Desktop"),
            lan("172.28.64.1", "vEthernet (WSL)"),
            lan("192.168.1.30", "Wi-Fi"),
            lan("10.0.0.8", "Ethernet"),
        ];
        addresses.sort_by(preferred_order);
        assert_eq!(addresses[0].ip.to_string(), "192.168.1.30");
        assert_eq!(addresses[1].ip.to_string(), "10.0.0.8");
        assert_eq!(addresses[2].interface, "Docker Desktop");
        assert_eq!(addresses[3].interface, "vEthernet (WSL)");
    }

    #[test]
    fn virtual_only_machine_still_yields_a_default() {
        let mut addresses = vec![
            lan("172.17.0.1", "Docker Desktop"),
            lan("192.168.56.1", "VirtualBox Host-Only"),
        ];
        addresses.sort_by(preferred_order);
        // Both are virtual (2), but the home-style 192.168 subnet still wins.
        assert_eq!(addresses[0].ip.to_string(), "192.168.56.1");
    }
}
