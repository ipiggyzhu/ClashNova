//! Script 增强:在嵌入式 JS 引擎(boa)中执行用户脚本
//! `function main(config) { ...; return config; }`,对运行时配置做编程式改写。
//!
//! 数据通路:YAML → JSON 字符串字面量注入 → `main(JSON.parse(...))` →
//! `JSON.stringify` 取回 → YAML。脚本无文件/网络能力,天然沙箱。

use boa_engine::{Context, Source};
use serde_yaml::Value;

use crate::CoreError;

/// 执行用户脚本并返回改写后的配置。
///
/// 失败情形(均为 [`CoreError::Script`]):脚本语法错误、`main` 未定义或
/// 执行抛异常、返回值不是对象(含 `undefined`/数组/标量)。
pub fn run_script(script: &str, config: &Value) -> Result<Value, CoreError> {
    // YAML → JSON 文本 → 再编码为 JS 字符串字面量(借 serde_json 转义)
    let json: serde_json::Value = serde_json::to_value(config)?;
    let json_text = serde_json::to_string(&json)?;
    let literal = serde_json::to_string(&json_text)?;

    let mut ctx = Context::default();
    ctx.eval(Source::from_bytes(script.as_bytes()))
        .map_err(|e| CoreError::Script(format!("脚本加载失败: {e}")))?;

    let call = format!("JSON.stringify(main(JSON.parse({literal})))");
    let result = ctx
        .eval(Source::from_bytes(call.as_bytes()))
        .map_err(|e| CoreError::Script(format!("main() 执行失败: {e}")))?;

    // JSON.stringify(undefined) 返回 undefined(非字符串) → 在此被拦截
    let out = result
        .as_string()
        .ok_or_else(|| CoreError::Script("main() 必须有返回值".into()))?
        .to_std_string_escaped();

    let json_out: serde_json::Value = serde_json::from_str(&out)
        .map_err(|e| CoreError::Script(format!("main() 返回值无法解析: {e}")))?;
    if !json_out.is_object() {
        return Err(CoreError::Script("main() 必须返回配置对象".into()));
    }
    Ok(serde_yaml::to_value(&json_out)?)
}

#[cfg(test)]
mod tests {
    use super::run_script;
    use crate::CoreError;
    use serde_yaml::Value;

    fn yaml(s: &str) -> Value {
        serde_yaml::from_str(s).expect("测试用 YAML 必须合法")
    }

    #[test]
    fn 脚本改写端口并追加规则() {
        let config = yaml("mixed-port: 7890\nrules:\n  - MATCH,DIRECT");
        let script = r#"
            function main(config) {
                config["mixed-port"] = 7897;
                config.rules.unshift("DOMAIN,example.com,REJECT");
                return config;
            }
        "#;
        let out = run_script(script, &config).expect("脚本应执行成功");
        assert_eq!(out.get("mixed-port"), Some(&Value::Number(7897.into())));
        assert_eq!(
            out.get("rules"),
            Some(&yaml("- DOMAIN,example.com,REJECT\n- MATCH,DIRECT"))
        );
    }

    #[test]
    fn 语法错误报_script() {
        let err = run_script("function main(c { return c }", &yaml("a: 1"))
            .expect_err("语法错误必须失败");
        assert!(matches!(err, CoreError::Script(_)), "实际: {err:?}");
    }

    #[test]
    fn 运行时异常报_script() {
        let err = run_script(
            "function main(c) { throw new Error('boom'); }",
            &yaml("a: 1"),
        )
        .expect_err("抛异常必须失败");
        let msg = err.to_string();
        assert!(msg.contains("boom"), "错误信息应含异常内容: {msg}");
    }

    #[test]
    fn 返回非对象报_script() {
        for bad in ["function main(c) {}", "function main(c) { return 42 }"] {
            let err = run_script(bad, &yaml("a: 1")).expect_err("非对象返回必须失败");
            assert!(matches!(err, CoreError::Script(_)), "实际: {err:?}");
        }
    }
}
