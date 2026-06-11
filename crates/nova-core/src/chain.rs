//! 配置增强链:订阅原文依序经过 Merge(YAML 补丁)与 Script(JS)两类
//! 增强项,产出最终下发 mihomo 的配置。任一项失败即中止并报出序号。

use serde_yaml::Value;

use crate::{deep_merge, script::run_script, CoreError};

/// 单个增强项(锁定契约 D 扩展)。
#[derive(Debug, Clone)]
pub enum EnhancerItem {
    /// YAML 深合并补丁(支持 `prepend-X` / `append-X`)。
    Merge(Value),
    /// JS 脚本,须定义 `function main(config)`。
    Script(String),
}

/// 将增强链逐项应用到 `base`(原地修改)。
///
/// 失败时返回 [`CoreError::Script`],信息带上 1 起始的序号,便于前端
/// 定位是哪一个增强项出错;Merge 项不会失败。
pub fn apply_chain(base: &mut Value, items: &[EnhancerItem]) -> Result<(), CoreError> {
    for (idx, item) in items.iter().enumerate() {
        match item {
            EnhancerItem::Merge(patch) => deep_merge(base, patch),
            EnhancerItem::Script(src) => {
                *base = run_script(src, base).map_err(|e| {
                    CoreError::Script(format!("增强链第 {} 项: {e}", idx + 1))
                })?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_chain, EnhancerItem};
    use serde_yaml::Value;

    fn yaml(s: &str) -> Value {
        serde_yaml::from_str(s).expect("测试用 YAML 必须合法")
    }

    #[test]
    fn merge_后_script_链式顺序生效() {
        let mut base = yaml("mixed-port: 7890\nrules:\n  - MATCH,DIRECT");
        let chain = vec![
            EnhancerItem::Merge(yaml("prepend-rules:\n  - 'DOMAIN,a.com,REJECT'")),
            EnhancerItem::Script(
                // 脚本能看到 merge 的产物:头部已是 a.com 规则
                r#"function main(c) {
                    if (c.rules[0] !== "DOMAIN,a.com,REJECT") throw new Error("顺序错误");
                    c.rules.push("GEOIP,CN,DIRECT");
                    return c;
                }"#
                .into(),
            ),
        ];
        apply_chain(&mut base, &chain).expect("链式应用应成功");
        assert_eq!(
            base.get("rules"),
            Some(&yaml(
                "- DOMAIN,a.com,REJECT\n- MATCH,DIRECT\n- GEOIP,CN,DIRECT"
            ))
        );
    }

    #[test]
    fn script_失败时报出序号() {
        let mut base = yaml("a: 1");
        let chain = vec![
            EnhancerItem::Merge(yaml("b: 2")),
            EnhancerItem::Script("function main(c) { return 1 }".into()),
        ];
        let err = apply_chain(&mut base, &chain).expect_err("第二项必须失败");
        assert!(err.to_string().contains("第 2 项"), "实际: {err}");
        // 失败前的 merge 已生效(调用方负责丢弃或回滚)
        assert_eq!(base.get("b"), Some(&Value::Number(2.into())));
    }

    #[test]
    fn 空链不变() {
        let mut base = yaml("a: 1");
        apply_chain(&mut base, &[]).expect("空链应成功");
        assert_eq!(base, yaml("a: 1"));
    }
}
