//! 可选大功能的唯一注册表与后端门卫。
//!
//! 关闭语义：前端隐藏入口 + 后端命令返回稳定码 `feature-disabled`。
//! 默认值以产品规格为准：除在线直读外全部开启；条漫保持现有实际体验。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeatureId {
    Webtoon,
    Online,
    Browser,
    Pdf,
    Opds,
    WebAccess,
    Updates,
    Backup,
    Diagnostics,
}

impl FeatureId {
    pub const ALL: [FeatureId; 9] = [
        FeatureId::Webtoon,
        FeatureId::Online,
        FeatureId::Browser,
        FeatureId::Pdf,
        FeatureId::Opds,
        FeatureId::WebAccess,
        FeatureId::Updates,
        FeatureId::Backup,
        FeatureId::Diagnostics,
    ];

    /// SQLite settings 表的持久化键。
    pub fn key(self) -> &'static str {
        match self {
            Self::Webtoon => "feature_webtoon",
            Self::Online => "feature_online",
            Self::Browser => "feature_browser",
            Self::Pdf => "feature_pdf",
            Self::Opds => "feature_opds",
            Self::WebAccess => "feature_web_access",
            Self::Updates => "feature_updates",
            Self::Backup => "feature_backup",
            Self::Diagnostics => "feature_diagnostics",
        }
    }

    /// 前后端 JSON 使用的 camelCase 标识（仅测试用）。
    #[cfg(test)]
    pub fn serde_name(self) -> &'static str {
        match self {
            Self::Webtoon => "webtoon",
            Self::Online => "online",
            Self::Browser => "browser",
            Self::Pdf => "pdf",
            Self::Opds => "opds",
            Self::WebAccess => "webAccess",
            Self::Updates => "updates",
            Self::Backup => "backup",
            Self::Diagnostics => "diagnostics",
        }
    }

    /// 旧版本使用的持久化键；只为升级/降级兼容保留。
    pub fn legacy_key(self) -> Option<&'static str> {
        match self {
            Self::Webtoon => Some("experimental_webtoon"),
            Self::Online => Some("experimental_online"),
            _ => None,
        }
    }

    pub fn label_zh(self) -> &'static str {
        match self {
            Self::Webtoon => "条漫模式",
            Self::Online => "在线直读",
            Self::Browser => "内置浏览器",
            Self::Pdf => "PDF 阅读",
            Self::Opds => "OPDS 远程书库",
            Self::WebAccess => "局域网访问",
            Self::Updates => "应用更新",
            Self::Backup => "备份与恢复",
            Self::Diagnostics => "问题反馈与诊断",
        }
    }

    pub fn get(self, flags: &FeatureFlags) -> bool {
        match self {
            Self::Webtoon => flags.webtoon,
            Self::Online => flags.online,
            Self::Browser => flags.browser,
            Self::Pdf => flags.pdf,
            Self::Opds => flags.opds,
            Self::WebAccess => flags.web_access,
            Self::Updates => flags.updates,
            Self::Backup => flags.backup,
            Self::Diagnostics => flags.diagnostics,
        }
    }

    pub fn set(self, flags: &mut FeatureFlags, value: bool) {
        match self {
            Self::Webtoon => flags.webtoon = value,
            Self::Online => flags.online = value,
            Self::Browser => flags.browser = value,
            Self::Pdf => flags.pdf = value,
            Self::Opds => flags.opds = value,
            Self::WebAccess => flags.web_access = value,
            Self::Updates => flags.updates = value,
            Self::Backup => flags.backup = value,
            Self::Diagnostics => flags.diagnostics = value,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FeatureFlags {
    pub webtoon: bool,
    pub online: bool,
    pub browser: bool,
    pub pdf: bool,
    pub opds: bool,
    pub web_access: bool,
    pub updates: bool,
    pub backup: bool,
    pub diagnostics: bool,
}

impl Default for FeatureFlags {
    fn default() -> Self {
        Self {
            webtoon: true,
            online: false,
            browser: true,
            pdf: true,
            opds: true,
            web_access: true,
            updates: true,
            backup: true,
            diagnostics: true,
        }
    }
}

pub(crate) fn ensure_enabled(flags: &FeatureFlags, feature: FeatureId) -> Result<(), String> {
    if feature.get(flags) {
        Ok(())
    } else {
        Err(format!(
            "{}已在设置中关闭（feature-disabled）",
            feature.label_zh()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_contract() {
        let f = FeatureFlags::default();
        assert!(f.webtoon);
        assert!(!f.online);
        assert!(f.browser && f.pdf && f.opds && f.web_access);
        assert!(f.updates && f.backup && f.diagnostics);
    }

    #[test]
    fn ids_are_unique_and_serde_camel_case() {
        let mut keys = std::collections::HashSet::new();
        for id in FeatureId::ALL {
            assert!(keys.insert(id.key()));
            assert_eq!(
                serde_json::to_string(&id).unwrap(),
                format!("\"{}\"", id.serde_name())
            );
        }
        assert_eq!(FeatureId::ALL.len(), 9);
    }

    #[test]
    fn toggles_are_independent() {
        let mut f = FeatureFlags::default();
        FeatureId::Browser.set(&mut f, false);
        assert!(!f.browser);
        assert!(f.pdf);
        FeatureId::Browser.set(&mut f, true);
        assert!(f.browser);
    }

    #[test]
    fn disabled_message_carries_stable_code() {
        let f = FeatureFlags {
            online: false,
            ..FeatureFlags::default()
        };
        let err = ensure_enabled(&f, FeatureId::Online).unwrap_err();
        assert!(err.contains("feature-disabled"));
        assert!(ensure_enabled(&f, FeatureId::Pdf).is_ok());
    }
}
