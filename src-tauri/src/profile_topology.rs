use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use serde_yaml::Value as Yaml;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTopology {
    pub content: String,
    pub proxies: Vec<Json>,
    pub groups: Vec<Json>,
}

fn root_mapping(content: &str) -> Result<serde_yaml::Mapping, String> {
    let root: Yaml =
        serde_yaml::from_str(content).map_err(|err| format!("YAML 语法错误: {err}"))?;
    root.as_mapping()
        .cloned()
        .ok_or_else(|| "配置根节点必须为 YAML 对象".into())
}

pub fn read_topology(content: String) -> Result<ProfileTopology, String> {
    let root = root_mapping(&content)?;
    let read = |key: &str| -> Result<Vec<Json>, String> {
        match root.get(Yaml::from(key)) {
            None | Some(Yaml::Null) => Ok(Vec::new()),
            Some(value) => serde_json::from_value(
                serde_json::to_value(value).map_err(|err| format!("转换 {key} 失败: {err}"))?,
            )
            .map_err(|_| format!("{key} 必须为对象数组")),
        }
    };
    let proxies = read("proxies")?;
    let groups = read("proxy-groups")?;
    if proxies
        .iter()
        .chain(&groups)
        .any(|entry| !entry.is_object())
    {
        return Err("节点和策略组必须为对象数组".into());
    }
    Ok(ProfileTopology {
        content,
        proxies,
        groups,
    })
}

fn name(entry: &Json) -> Result<&str, String> {
    entry
        .get("name")
        .and_then(Json::as_str)
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "节点和策略组都需要名称".into())
}

fn string_list<'a>(entry: &'a Json, key: &str) -> Result<Vec<&'a str>, String> {
    match entry.get(key) {
        None => Ok(Vec::new()),
        Some(Json::Array(items)) => items
            .iter()
            .map(|item| item.as_str().ok_or_else(|| format!("{key} 必须为文本数组")))
            .collect(),
        _ => Err(format!("{key} 必须为文本数组")),
    }
}

fn rule_target_range(rule: &str) -> Option<std::ops::Range<usize>> {
    // SUB-RULE 的尾字段是子规则名称，而不是节点/策略组。
    let kind = rule.split(',').next()?.trim();
    if kind.eq_ignore_ascii_case("SUB-RULE") {
        return None;
    }
    let target_separator = if kind.eq_ignore_ascii_case("MATCH") {
        0
    } else {
        1
    };
    let mut depth = 0usize;
    let mut separators = Vec::new();
    for (index, ch) in rule.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => separators.push(index),
            _ => {}
        }
    }
    let mut end = rule.len();
    for (position, separator) in separators.into_iter().enumerate().rev() {
        let part = &rule[separator + 1..end];
        let target = part.trim();
        if position <= target_separator
            || !matches!(target.to_ascii_lowercase().as_str(), "no-resolve" | "src")
        {
            let start = separator + 1 + part.len() - part.trim_start().len();
            return Some(start..start + target.len());
        }
        end = separator;
    }
    None
}

fn rename_rules(value: &mut Yaml, renames: &HashMap<String, String>) {
    match value {
        Yaml::String(rule) => {
            if let Some(range) = rule_target_range(rule) {
                if let Some(next) = renames.get(&rule[range.clone()]) {
                    rule.replace_range(range, next);
                }
            }
        }
        Yaml::Sequence(items) => items
            .iter_mut()
            .for_each(|item| rename_rules(item, renames)),
        Yaml::Mapping(map) => map
            .values_mut()
            .for_each(|item| rename_rules(item, renames)),
        _ => {}
    }
}

fn rename_references(root: &mut Yaml, renames: &HashMap<String, String>) {
    match root {
        Yaml::Mapping(map) => {
            for (key, value) in map.iter_mut() {
                match key.as_str() {
                    Some("dialer-proxy") => {
                        if let Some(next) = value.as_str().and_then(|name| renames.get(name)) {
                            *value = Yaml::from(next.clone());
                        }
                    }
                    Some("proxies") => {
                        if let Some(items) = value.as_sequence_mut() {
                            for item in items {
                                if let Some(next) = item.as_str().and_then(|name| renames.get(name))
                                {
                                    *item = Yaml::from(next.clone());
                                } else {
                                    rename_references(item, renames);
                                }
                            }
                        }
                    }
                    Some("rules" | "sub-rules") => rename_rules(value, renames),
                    _ => rename_references(value, renames),
                }
            }
        }
        Yaml::Sequence(items) => items
            .iter_mut()
            .for_each(|item| rename_references(item, renames)),
        _ => {}
    }
}

/// 仅替换节点/策略组，保留 DNS、规则、provider 和其他未编辑字段。
pub fn write_topology(
    original: &str,
    proxies: Vec<Json>,
    groups: Vec<Json>,
    renames: &HashMap<String, String>,
) -> Result<String, String> {
    let old = read_topology(original.to_string())?;
    let old_names: HashSet<&str> = old
        .proxies
        .iter()
        .chain(&old.groups)
        .filter_map(|item| item.get("name").and_then(Json::as_str))
        .collect();
    let mut names = HashSet::new();
    for entry in proxies.iter().chain(&groups) {
        let name = name(entry)?;
        if name != name.trim() || name.contains([',', '\n', '\r']) {
            return Err("名称不能包含逗号、换行或首尾空白".into());
        }
        if !names.insert(name)
            || matches!(
                name,
                "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "GLOBAL" | "COMPATIBLE"
            )
        {
            return Err(format!("名称重复或使用了内置策略名: {name}"));
        }
        if entry
            .get("type")
            .and_then(Json::as_str)
            .is_none_or(|kind| kind.trim().is_empty())
        {
            return Err(format!("{name} 缺少类型"));
        }
        if let Some(port) = entry.get("port") {
            if port
                .as_u64()
                .is_none_or(|port| port == 0 || port > u16::MAX as u64)
            {
                return Err(format!("{name} 的端口需要在 1–65535 之间"));
            }
        }
    }
    for (from, to) in renames {
        if !old_names.contains(from.as_str()) || !names.contains(to.as_str()) {
            return Err("重命名记录与当前编辑内容不一致，请重新打开编辑器".into());
        }
        if from != to && old_names.contains(to.as_str()) {
            return Err("重命名不能占用本次编辑中其他条目的原名，请先保存后再编辑".into());
        }
    }
    let mut root = Yaml::Mapping(root_mapping(original)?);
    root["proxies"] = serde_yaml::to_value(&proxies).map_err(|err| err.to_string())?;
    root["proxy-groups"] = serde_yaml::to_value(&groups).map_err(|err| err.to_string())?;
    rename_references(&mut root, renames);
    let result = read_topology(serde_yaml::to_string(&root).map_err(|err| err.to_string())?)?;
    let targets: HashSet<&str> = names
        .iter()
        .copied()
        .chain([
            "DIRECT",
            "REJECT",
            "REJECT-DROP",
            "PASS",
            "GLOBAL",
            "COMPATIBLE",
        ])
        .collect();
    let providers: HashSet<&str> = root
        .get("proxy-providers")
        .and_then(Yaml::as_mapping)
        .map(|providers| providers.keys().filter_map(Yaml::as_str).collect())
        .unwrap_or_default();
    let mut graph = HashMap::new();
    for proxy in &result.proxies {
        if let Some(target) = proxy.get("dialer-proxy").and_then(Json::as_str) {
            if !targets.contains(target) {
                return Err(format!(
                    "节点 {} 的 dialer-proxy 不存在: {target}",
                    name(proxy)?
                ));
            }
        }
    }
    for group in &result.groups {
        let members = string_list(group, "proxies")?;
        for member in &members {
            if !targets.contains(member) {
                return Err(format!(
                    "策略组 {} 引用了不存在的节点或策略组: {member}",
                    name(group)?
                ));
            }
        }
        for provider in string_list(group, "use")? {
            if !providers.contains(provider) {
                return Err(format!(
                    "策略组 {} 引用了不存在的 provider: {provider}",
                    name(group)?
                ));
            }
        }
        graph.insert(name(group)?, members);
    }
    fn visit<'a>(
        name: &'a str,
        graph: &HashMap<&'a str, Vec<&'a str>>,
        active: &mut HashSet<&'a str>,
        done: &mut HashSet<&'a str>,
    ) -> Result<(), String> {
        if done.contains(name) {
            return Ok(());
        }
        if !active.insert(name) {
            return Err(format!("策略组存在循环引用: {name}"));
        }
        if let Some(members) = graph.get(name) {
            for member in members.iter().filter(|member| graph.contains_key(**member)) {
                visit(member, graph, active, done)?;
            }
        }
        active.remove(name);
        done.insert(name);
        Ok(())
    }
    let mut done = HashSet::new();
    for group in graph.keys() {
        visit(group, &graph, &mut HashSet::new(), &mut done)?;
    }
    // 删除动作不能悄悄留下原先有效的分流目标，包含子规则内部的代理目标。
    fn validate_rules(
        value: &Yaml,
        old: &HashSet<&str>,
        targets: &HashSet<&str>,
    ) -> Result<(), String> {
        match value {
            Yaml::String(rule) => {
                if let Some(range) = rule_target_range(rule) {
                    let target = &rule[range];
                    if old.contains(target) && !targets.contains(target) {
                        return Err(format!("分流规则仍引用已删除的策略: {target}"));
                    }
                }
            }
            Yaml::Sequence(items) => {
                for item in items {
                    validate_rules(item, old, targets)?;
                }
            }
            Yaml::Mapping(map) => {
                for item in map.values() {
                    validate_rules(item, old, targets)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    for key in ["rules", "sub-rules"] {
        if let Some(rules) = root.get(key) {
            validate_rules(rules, &old_names, &targets)?;
        }
    }
    Ok(result.content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SOURCE: &str = "proxies:\n  - {name: node, type: socks5, server: 127.0.0.1, port: 1080, udp: true}\nproxy-groups:\n  - {name: group, type: select, proxies: [node]}\nproxy-providers:\n  airport: {type: file, path: ./nodes.yaml}\ndns: {enable: true}\nrules: [MATCH,group]\n";

    fn fixture() -> ProfileTopology {
        read_topology(SOURCE.replace(
            "rules: [MATCH,group]",
            "rules: ['MATCH,group', 'IP-CIDR,192.0.2.0/24,group,no-resolve']",
        ))
        .unwrap()
    }

    #[test]
    fn topology_roundtrip_preserves_providers_and_unknown_node_fields() {
        let mut draft = fixture();
        draft.proxies[0]["server"] = json!("proxy.example.invalid");
        let yaml =
            write_topology(&draft.content, draft.proxies, draft.groups, &HashMap::new()).unwrap();
        let value: Yaml = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(value["proxies"][0]["udp"], Yaml::Bool(true));
        assert_eq!(value["dns"]["enable"], Yaml::Bool(true));
        assert_eq!(
            value["proxy-providers"]["airport"]["path"].as_str(),
            Some("./nodes.yaml")
        );
        assert_eq!(value["rules"].as_sequence().unwrap().len(), 2);
    }

    #[test]
    fn renaming_rewrites_group_and_rule_references() {
        let mut draft = fixture();
        draft.proxies[0]["name"] = json!("renamed-node");
        draft.groups[0]["name"] = json!("renamed-group");
        let names = HashMap::from([
            ("node".into(), "renamed-node".into()),
            ("group".into(), "renamed-group".into()),
        ]);
        let yaml = write_topology(&draft.content, draft.proxies, draft.groups, &names).unwrap();
        let value: Yaml = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(
            value["proxy-groups"][0]["proxies"][0].as_str(),
            Some("renamed-node")
        );
        assert_eq!(value["rules"][0].as_str(), Some("MATCH,renamed-group"));
        assert_eq!(
            value["rules"][1].as_str(),
            Some("IP-CIDR,192.0.2.0/24,renamed-group,no-resolve")
        );
    }

    #[test]
    fn renaming_handles_rule_options_and_subrules_without_renaming_subrule_names() {
        for rule in [
            "MATCH,src",
            "DOMAIN,example.invalid,src",
            "AND,((NETWORK,UDP),(DST-PORT,443)),src",
        ] {
            assert_eq!(&rule[rule_target_range(rule).unwrap()], "src");
        }
        let mut draft = fixture();
        draft.content = draft.content.replace("rules: ['MATCH,group', 'IP-CIDR,192.0.2.0/24,group,no-resolve']", "rules: ['SUB-RULE,(DOMAIN,example.invalid),group', 'IP-CIDR,192.0.2.0/24, group, no-resolve,src']\nsub-rules:\n  group: ['MATCH,group']");
        draft.groups[0]["name"] = json!("next-group");
        let yaml = write_topology(
            &draft.content,
            draft.proxies,
            draft.groups,
            &HashMap::from([("group".into(), "next-group".into())]),
        )
        .unwrap();
        let value: Yaml = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(
            value["rules"][0].as_str(),
            Some("SUB-RULE,(DOMAIN,example.invalid),group")
        );
        assert_eq!(
            value["rules"][1].as_str(),
            Some("IP-CIDR,192.0.2.0/24, next-group, no-resolve,src")
        );
        assert_eq!(
            value["sub-rules"]["group"][0].as_str(),
            Some("MATCH,next-group")
        );
    }

    #[test]
    fn topology_rejects_duplicates_cycles_and_dangling_references() {
        let draft = fixture();
        let mut duplicate = draft.proxies.clone();
        duplicate.push(duplicate[0].clone());
        assert!(write_topology(
            &draft.content,
            duplicate,
            draft.groups.clone(),
            &HashMap::new()
        )
        .unwrap_err()
        .contains("重复"));
        assert!(write_topology(
            &draft.content,
            Vec::new(),
            draft.groups.clone(),
            &HashMap::new()
        )
        .unwrap_err()
        .contains("不存在"));
        let cycles = vec![
            json!({"name":"a", "type":"select", "proxies":["b"]}),
            json!({"name":"b", "type":"select", "proxies":["a"]}),
        ];
        assert!(write_topology(
            &draft.content,
            draft.proxies.clone(),
            cycles,
            &HashMap::new()
        )
        .unwrap_err()
        .contains("循环"));
        assert!(
            write_topology(&draft.content, draft.proxies, Vec::new(), &HashMap::new())
                .unwrap_err()
                .contains("仍引用")
        );
    }

    #[test]
    fn topology_rejects_invalid_ports_and_preserves_valid_provider_groups() {
        let mut draft = fixture();
        draft.proxies[0]["port"] = json!(65536);
        assert!(write_topology(
            &draft.content,
            draft.proxies.clone(),
            draft.groups.clone(),
            &HashMap::new()
        )
        .is_err());
        draft.proxies[0]["port"] = json!(1080);
        draft.groups[0] = json!({"name":"group", "type":"select", "use":["airport"]});
        assert!(write_topology(
            &draft.content,
            draft.proxies.clone(),
            draft.groups.clone(),
            &HashMap::new()
        )
        .is_ok());
        draft.groups[0]["use"] = json!(["unknown"]);
        assert!(
            write_topology(&draft.content, draft.proxies, draft.groups, &HashMap::new())
                .unwrap_err()
                .contains("provider")
        );
    }
}
