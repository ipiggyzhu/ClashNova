//! YAML 深合并:对象递归合并;`prepend-X` / `append-X` 仅当 base 的 `X`
//! 是数组时向头/尾插入,否则按普通键覆盖。

use serde_yaml::Value;

/// 将 `patch` 递归合并进 `base`(锁定契约 D)。
///
/// 规则:
/// - 双方同键且均为 mapping → 递归合并;
/// - `prepend-X` / `append-X` 且 base 的 `X` 为数组 → 向 `base.X` 头/尾插入
///   (patch 值为数组时逐元素插入,否则插入单元素),`prepend-X` 键本身不落入 base;
/// - 其余情况(含 base.X 非数组的 prepend-/append- 键)→ 普通键覆盖/新增;
/// - base 或 patch 任一不是 mapping 时,整体以 patch 覆盖 base。
pub fn deep_merge(base: &mut Value, patch: &Value) {
    let (Value::Mapping(base_map), Value::Mapping(patch_map)) = (&mut *base, patch) else {
        *base = patch.clone();
        return;
    };

    for (key, patch_val) in patch_map {
        // prepend-X / append-X:仅当 base.X 已是数组时生效
        if let Some(key_str) = key.as_str() {
            let (target, prepend) = match (
                key_str.strip_prefix("prepend-"),
                key_str.strip_prefix("append-"),
            ) {
                (Some(t), _) => (Some(t), true),
                (None, Some(t)) => (Some(t), false),
                _ => (None, false),
            };
            if let Some(target) = target {
                if let Some(Value::Sequence(seq)) =
                    base_map.get_mut(Value::String(target.to_string()))
                {
                    splice_sequence(seq, patch_val, prepend);
                    continue;
                }
            }
        }
        // 普通合并:双方均为 mapping → 递归;否则覆盖/新增
        match (base_map.get_mut(key), patch_val) {
            (Some(base_val @ Value::Mapping(_)), Value::Mapping(_)) => {
                deep_merge(base_val, patch_val);
            }
            _ => {
                base_map.insert(key.clone(), patch_val.clone());
            }
        }
    }
}

/// 把 `patch_val` 插入数组头/尾:数组则逐元素插入,标量则插入单元素。
fn splice_sequence(seq: &mut Vec<Value>, patch_val: &Value, prepend: bool) {
    let items: Vec<Value> = match patch_val {
        Value::Sequence(s) => s.clone(),
        other => vec![other.clone()],
    };
    if prepend {
        seq.splice(0..0, items);
    } else {
        seq.extend(items);
    }
}

#[cfg(test)]
mod tests {
    use super::deep_merge;
    use serde_yaml::Value;

    fn yaml(s: &str) -> Value {
        serde_yaml::from_str(s).expect("测试用 YAML 必须合法")
    }

    #[test]
    fn 标量覆盖与新增键() {
        let mut base = yaml("a: 1\nb: old\nkeep: true");
        let patch = yaml("b: new\nc: 3");
        deep_merge(&mut base, &patch);
        assert_eq!(base, yaml("a: 1\nb: new\nkeep: true\nc: 3"));
    }

    #[test]
    fn 嵌套对象递归合并() {
        let mut base = yaml(
            "dns:\n  enable: false\n  listen: 0.0.0.0:53\n  nameserver:\n    - 1.1.1.1",
        );
        let patch = yaml("dns:\n  enable: true\n  ipv6: false");
        deep_merge(&mut base, &patch);
        let dns = base.get("dns").expect("dns 应保留");
        assert_eq!(dns.get("enable"), Some(&Value::Bool(true)));
        assert_eq!(dns.get("ipv6"), Some(&Value::Bool(false)));
        assert_eq!(
            dns.get("listen"),
            Some(&Value::String("0.0.0.0:53".into()))
        );
        assert_eq!(dns.get("nameserver"), Some(&yaml("- 1.1.1.1")));
    }

    #[test]
    fn prepend_rules_头插_非数组键时当普通键() {
        let mut base = yaml("mode: rule\nrules:\n  - B\n  - C");
        let patch = yaml("prepend-rules:\n  - A\nprepend-mode:\n  - x");
        deep_merge(&mut base, &patch);
        // base.rules 是数组 → 头插,且 prepend-rules 键不落入 base
        assert_eq!(base.get("rules"), Some(&yaml("- A\n- B\n- C")));
        assert!(base.get("prepend-rules").is_none());
        // base.mode 是标量 → prepend-mode 按普通键覆盖(新增)
        assert_eq!(base.get("prepend-mode"), Some(&yaml("- x")));
        assert_eq!(base.get("mode"), Some(&Value::String("rule".into())));
    }

    #[test]
    fn append_proxies_尾插_缺失键时当普通键() {
        let mut base = yaml("proxies:\n  - p1");
        let patch = yaml("append-proxies:\n  - p2\n  - p3\nappend-foo: bar");
        deep_merge(&mut base, &patch);
        assert_eq!(base.get("proxies"), Some(&yaml("- p1\n- p2\n- p3")));
        assert!(base.get("append-proxies").is_none());
        // base 没有 foo 数组 → append-foo 按普通键新增
        assert_eq!(base.get("append-foo"), Some(&Value::String("bar".into())));
    }
}
