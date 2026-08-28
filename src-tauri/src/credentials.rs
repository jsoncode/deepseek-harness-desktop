//! 凭据配置文件（`$DSH_HOME/.credentials.yaml`）格式兼容性检查与修复。
//!
//! dsh 宿主升级（如 0.1.0-rc.x → 0.1.1-rc.x）后，凭据文档从「扁平 ref → 字符串」
//! 布局升级为带版本的布局（`version: 1` + `refs:`/`records:` 区段，见
//! @deepseek-ai/dsh-credentials-local 的 DOCUMENT_VERSION）。旧布局、手工编辑或
//! 其他工具写出的不兼容文件会让 dsh web 在启动时直接报插件树加载失败——
//! 典型报错：`credentials-local: the value for "version" in ... must be a string`，
//! 且错误信息不直观、用户无从下手。
//!
//! 本模块在启动 dsh 服务前先按当前 dsh 的文档 schema 校验该文件：
//! - 兼容 → 放行，正常启动；
//! - 不兼容 → 返回打码后的文件内容与最新格式模板，由前端弹框征询用户；
//! - 用户确认后调用 `fix_credentials` 把文件重写为最新规范格式（凭据值全部保留），
//!   随后再启动服务。

use serde::Serialize;
use serde_yaml::{Mapping, Value};
use std::path::PathBuf;

/// dsh 当前读取的凭据文档版本（与 dsh-credentials-local 的 DOCUMENT_VERSION 一致）
const DOCUMENT_VERSION: i64 = 1;
/// 允许的顶层键；其余一律拒绝（与 dsh「静默忽略即失效」的严格语义一致）
const TOP_KEYS: [&str; 3] = ["version", "refs", "records"];
/// 结构性的、不含机密信息的键：展示打码内容时这些行的值原样保留
const STRUCTURAL_KEYS: [&str; 4] = ["version", "refs", "records", "kind"];

// ---------------------------------------------------------------------------
// 路径与基础工具
// ---------------------------------------------------------------------------

/// 凭据文档路径：`$DSH_HOME/.credentials.yaml`，缺省 `~/.dsh/.credentials.yaml`
/// （与 dsh-credentials-local resolveSpec 的默认解析一致）
fn credentials_path() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("DSH_HOME") {
        let h = h.trim();
        if !h.is_empty() {
            return Some(PathBuf::from(h).join(".credentials.yaml"));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(".dsh").join(".credentials.yaml"))
}

/// 凭据引用名语法（与 dsh-credentials 的 REF_PATTERN `^[A-Za-z_][A-Za-z0-9_]*$` 一致）
fn is_credential_ref(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 兜底逐行扫描时只认大写 ref 名（`kind`/`payload`/`access` 等记录字段均为小写，
/// 不会误收；真实 env 引用几乎都是大写形式）
fn is_upper_ref(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// 记录键语法：`<scope>/<id>`，两段均为小写连字符标识符
fn is_record_key(key: &str) -> bool {
    let Some((scope, id)) = key.split_once('/') else {
        return false;
    };
    let seg_ok = |s: &str| {
        let mut it = s.chars();
        match it.next() {
            Some(c) if c.is_ascii_lowercase() => {}
            _ => return false,
        }
        it.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    !scope.is_empty() && !id.is_empty() && seg_ok(scope) && seg_ok(id)
}

// ---------------------------------------------------------------------------
// 校验（与 dsh-credentials-local 0.1.1-rc.x 的 parseCredentialsDocument 对齐）
// ---------------------------------------------------------------------------

/// 校验文档是否与当前 dsh 兼容；不兼容时返回面向用户的中文原因。
fn validate_document(root: &Value) -> Result<(), String> {
    // 空文档在 YAML 中解析为 null；dsh 视作空凭据库（合法）
    if root.is_null() {
        return Ok(());
    }
    let mapping = root
        .as_mapping()
        .ok_or_else(|| "文件根节点必须是键值映射（mapping）".to_string())?;
    if mapping.is_empty() {
        return Ok(()); // 空映射 = 空凭据库，dsh 视作合法
    }
    if !mapping.contains_key("version") {
        // 旧版扁平格式：若与 dsh 可自动迁移的形态完全一致（合法 ref 名 → 非空字符串），
        // 则 dsh 启动时会原地升级、值原样保留，无需弹框；其他扁平形态才会加载失败
        let flat_ok = mapping.iter().all(|(k, v)| {
            k.as_str().map(is_credential_ref).unwrap_or(false)
                && matches!(v, Value::String(s) if !s.is_empty())
        });
        if flat_ok {
            return Ok(());
        }
        return Err(
            "缺少 version 字段，且文件内容不是 dsh 可自动迁移的旧版扁平格式".to_string(),
        );
    }
    // dsh 要求 version 严格等于整数 1（字符串 "1" 同样会被拒绝）
    let version = mapping.get("version").ok_or_else(|| {
        "缺少 version 字段：这是旧版扁平格式的凭据文件（dsh 无法读取）".to_string()
    })?;
    if version.as_f64() != Some(1.0) {
        return Err(format!(
            "version 字段的值为 {}，当前 dsh 只支持版本 {DOCUMENT_VERSION}",
            yaml_scalar_text(version)
        ));
    }
    for key in mapping.keys() {
        let k = key.as_str().unwrap_or("<非字符串键>");
        if !TOP_KEYS.contains(&k) {
            return Err(format!(
                "存在未知的顶层键 \"{k}\"（dsh 只接受 version / refs / records）"
            ));
        }
    }
    validate_section(mapping.get("refs"), "refs", false)?;
    validate_section(mapping.get("records"), "records", true)?;
    Ok(())
}

/// 校验一个区段是否为合法映射；`is_records` 时按 records 的条目结构逐条校验
fn validate_section(section: Option<&Value>, name: &str, is_records: bool) -> Result<(), String> {
    let map = match section {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::Mapping(m)) => m,
        Some(_) => return Err(format!("\"{name}\" 必须是键值映射（mapping）")),
    };
    for (k, v) in map {
        let key = k.as_str().unwrap_or("<非字符串键>");
        if is_records {
            validate_record(key, v)?;
        } else {
            if !is_credential_ref(key) {
                return Err(format!(
                    "refs 键 \"{key}\" 不是合法的凭据引用名（需为 env 变量名形式）"
                ));
            }
            match v {
                Value::String(s) if !s.is_empty() => {}
                Value::String(_) => {
                    return Err(format!("refs 中 \"{key}\" 的值为空，请删除该键"))
                }
                _ => return Err(format!("refs 中 \"{key}\" 的值必须是字符串")),
            }
        }
    }
    Ok(())
}

/// 校验一条记录（api-key / grant 两种 kind）
fn validate_record(key: &str, value: &Value) -> Result<(), String> {
    if !is_record_key(key) {
        return Err(format!(
            "records 键 \"{key}\" 不是合法的记录键（应为 <scope>/<id> 形式）"
        ));
    }
    let rec = value
        .as_mapping()
        .ok_or_else(|| format!("记录 \"{key}\" 必须是映射（mapping）"))?;
    let kind = rec
        .get("kind")
        .and_then(|k| k.as_str())
        .ok_or_else(|| format!("记录 \"{key}\" 缺少 kind 字段"))?;
    match kind {
        "api-key" => {
            if let Some(k) = rec.get("key") {
                match k {
                    Value::String(s) if !s.is_empty() => {}
                    _ => return Err(format!("记录 \"{key}\" 的 key 必须是非空字符串")),
                }
            }
            if let Some(env) = rec.get("env") {
                let env_map = env
                    .as_mapping()
                    .ok_or_else(|| format!("记录 \"{key}\" 的 env 必须是映射"))?;
                for (n, val) in env_map {
                    let name = n.as_str().unwrap_or("<非字符串键>");
                    if !is_credential_ref(name) {
                        return Err(format!(
                            "记录 \"{key}\" env 键 \"{name}\" 不是合法的凭据引用名"
                        ));
                    }
                    match val {
                        Value::String(s) if !s.is_empty() => {}
                        _ => return Err(format!("记录 \"{key}\" env \"{name}\" 必须是非空字符串")),
                    }
                }
            }
        }
        "grant" => {
            if !rec.contains_key("payload") {
                return Err(format!("记录 \"{key}\" 缺少 payload 字段"));
            }
        }
        other => return Err(format!("记录 \"{key}\" 存在未知的 kind \"{other}\"")),
    }
    Ok(())
}

/// 把 YAML 标量渲染成便于展示的文本
fn yaml_scalar_text(v: &Value) -> String {
    match v {
        Value::String(s) => format!("\"{s}\""),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        other => format!("{other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 打码展示
// ---------------------------------------------------------------------------

/// 对文件内容打码：仅对「键: 值」行中的值部分做遮盖；结构键
/// （version/refs/records/kind）与纯结构行原样保留。值最多保留前 4 个字符。
fn mask_content(text: &str) -> String {
    text.lines().map(mask_line).collect::<Vec<_>>().join("\n")
}

fn mask_line(line: &str) -> String {
    let Some(idx) = line.find(':') else {
        return line.to_string();
    };
    let key = line[..idx].trim().trim_start_matches("- ").trim();
    if STRUCTURAL_KEYS.contains(&key)
        || key.is_empty()
        || key.contains(' ')
        || key.contains('\t')
    {
        return line.to_string();
    }
    let rest = &line[idx + 1..];
    let Some(rel) = rest.find(|c: char| !c.is_whitespace()) else {
        return line.to_string(); // "key:" 无值
    };
    let abs = idx + 1 + rel;
    let value = &line[abs..];
    let masked = if value.starts_with('"') && value.ends_with('"')
        || value.starts_with('\'') && value.ends_with('\'')
    {
        let inner = &value[1..value.len() - 1];
        format!("\"{}\"", mask_secret(inner))
    } else {
        mask_secret(value.trim_end())
    };
    format!("{}{}", &line[..abs], masked)
}

/// 打码单个值：空值显示 `****`；否则保留前 4 个字符，其余以 `****` 代替
fn mask_secret(s: &str) -> String {
    let s = s.trim();
    if s.is_empty() {
        return "****".to_string();
    }
    if s.chars().count() <= 4 {
        return "****".to_string();
    }
    let keep = s.chars().take(4).collect::<String>();
    format!("{keep}****")
}

// ---------------------------------------------------------------------------
// 修复：提取 + 重写为最新规范格式
// ---------------------------------------------------------------------------

/// 从任意可识别的布局中提取 refs / records，返回 (refs, records, 被移除的空值条目数)。
/// 优先完整 YAML 解析；解析失败时退化为逐行扫描（覆盖花括号缩进错误、flow 段缺逗号等
/// 已损坏但仍能看出 `KEY: value` 结构的文件）。
fn extract_document(text: &str) -> Result<(Mapping, Mapping, usize), String> {
    if let Ok(root) = serde_yaml::from_str::<Value>(text) {
        if let Some(m) = root.as_mapping() {
            let mut refs = Mapping::new();
            let mut dropped = 0usize;
            // 旧版扁平格式：无 version/refs/records，整个文档即 refs 表
            if !m.contains_key("version") && !m.contains_key("refs") && !m.contains_key("records")
            {
                for (k, v) in m {
                    if let (Some(key), Some(val)) = (k.as_str(), normalize_ref_value(v)) {
                        refs.insert(Value::String(key.into()), val);
                    } else {
                        dropped += 1;
                    }
                }
            } else if let Some(Value::Mapping(r)) = m.get("refs") {
                for (k, v) in r {
                    if let (Some(key), Some(val)) = (k.as_str(), normalize_ref_value(v)) {
                        refs.insert(Value::String(key.into()), val);
                    } else {
                        dropped += 1;
                    }
                }
            }
            let records = match m.get("records") {
                Some(Value::Mapping(r)) => r.clone(),
                _ => Mapping::new(),
            };
            return Ok((refs, records, dropped));
        }
    }
    // 兜底逐行扫描：只认大写 ref 名，避免把 records 的小写字段（kind/payload/access…）
    // 误收进 refs
    let mut refs = Mapping::new();
    let mut dropped = 0usize;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(idx) = line.find(':') else {
            continue;
        };
        let key = line[..idx].trim();
        if !is_upper_ref(key) {
            continue;
        }
        let value = line[idx + 1..].trim().trim_matches(|c| c == '"' || c == '\'');
        if value.is_empty() {
            dropped += 1;
            continue;
        }
        refs.insert(Value::String(key.into()), Value::String(value.into()));
    }
    if refs.is_empty() {
        return Err("无法识别凭据文件的内容布局，请手动检查该文件".into());
    }
    Ok((refs, Mapping::new(), dropped))
}

/// 把 ref 值规范化为非空字符串；空值 / 非标量返回 None（由调用方计入移除数）
fn normalize_ref_value(v: &Value) -> Option<Value> {
    match v {
        Value::String(s) if !s.is_empty() => Some(Value::String(s.clone())),
        Value::Number(n) => Some(Value::String(n.to_string())),
        Value::Bool(b) => Some(Value::String(b.to_string())),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 凭据文件兼容性检查结果
#[derive(Serialize, Clone)]
pub struct CredentialsCheck {
    /// 是否与当前 dsh 兼容（兼容则无需任何处理）
    pub compatible: bool,
    /// 不兼容原因（面向用户的中文描述）；兼容时为 None
    pub reason: Option<String>,
    /// 凭据文件绝对路径；定位失败时为 None
    pub path: Option<String>,
    /// 当前文件内容（值已打码）；文件缺失/无法读取时为 None
    pub masked_content: Option<String>,
    /// 最新格式模板（全部为占位值）；仅不兼容时提供
    pub template: Option<String>,
}

/// 最新格式模板（展示给用户参考；占位值均为示例）
const TEMPLATE: &str = r#"version: 1

refs:
  DEEPSEEK_API_KEY: sk-xxxxx
  OPENAI_API_KEY: sk-xxxxx

records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:
      type: oauth
      access: eyJhbGciOi...
"#;

/// 启动 dsh 服务前的凭据文件格式检查。
///
/// 文件缺失 / 读取失败 / 与当前 dsh 兼容 → `compatible: true`（不阻断启动，
/// 其余交由 dsh 自行处理）；不兼容 → `compatible: false` 并附带原因、打码内容与模板。
#[tauri::command]
pub fn check_credentials_compat() -> Result<CredentialsCheck, String> {
    let Some(path) = credentials_path() else {
        return Ok(CredentialsCheck {
            compatible: true,
            reason: None,
            path: None,
            masked_content: None,
            template: None,
        });
    };
    let path_str = path.to_string_lossy().into_owned();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => {
            // 不存在 = 空凭据库（合法）；权限等读取失败也不阻断，交由 dsh 自行报错
            return Ok(CredentialsCheck {
                compatible: true,
                reason: None,
                path: Some(path_str),
                masked_content: None,
                template: None,
            });
        }
    };
    let problem = match serde_yaml::from_str::<Value>(&text) {
        Err(e) => Some(format!("文件不是有效的 YAML（可能格式损坏）：{e}")),
        Ok(root) => match validate_document(&root) {
            Ok(()) => None,
            Err(reason) => Some(reason),
        },
    };
    let Some(problem) = problem else {
        return Ok(CredentialsCheck {
            compatible: true,
            reason: None,
            path: Some(path_str),
            masked_content: None,
            template: None,
        });
    };
    Ok(CredentialsCheck {
        compatible: false,
        reason: Some(problem),
        path: Some(path_str),
        masked_content: Some(mask_content(&text)),
        template: Some(TEMPLATE.to_string()),
    })
}

/// 把凭据文件重写为最新规范格式（凭据值全部保留），返回修复摘要。
/// 无法识别内容布局时拒绝写回，避免覆盖用户文件。
#[tauri::command]
pub fn fix_credentials() -> Result<String, String> {
    let path = credentials_path().ok_or("无法定位 .dsh 目录")?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取凭据文件失败: {e}"))?;
    let (refs, records, dropped) = extract_document(&text)?;
    if refs.is_empty() && records.is_empty() {
        return Err("无法从当前文件中识别出任何凭据条目，已中止修复（请手动检查该文件）".into());
    }
    let mut root = Mapping::new();
    root.insert(
        Value::String("version".into()),
        Value::Number(DOCUMENT_VERSION.into()),
    );
    if !refs.is_empty() {
        root.insert(Value::String("refs".into()), Value::Mapping(refs));
    }
    if !records.is_empty() {
        root.insert(Value::String("records".into()), Value::Mapping(records));
    }
    let out = serde_yaml::to_string(&Value::Mapping(root))
        .map_err(|e| format!("生成最新格式内容失败: {e}"))?;
    std::fs::write(&path, &out).map_err(|e| format!("写回凭据文件失败: {e}"))?;
    let mut msg = format!("已更新为最新格式：{}", path.display());
    if dropped > 0 {
        msg.push_str(&format!("（移除了 {dropped} 个空值条目）"));
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(text: &str) -> Result<(), String> {
        let v = serde_yaml::from_str::<Value>(text).map_err(|e| format!("parse: {e}"))?;
        validate_document(&v)
    }

    #[test]
    fn 最新规范格式通过校验() {
        let doc = "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-abc\nrecords:\n  llm-pi-ai/x:\n    kind: grant\n    payload: {}\n";
        assert!(check(doc).is_ok());
    }

    #[test]
    fn flow风格refs通过校验() {
        let doc = "version: 1\nrefs:\n  {\n    DEEPSEEK_API_KEY: sk-abc\n  }\n";
        assert!(check(doc).is_ok());
    }

    #[test]
    fn 空文档与仅版本号通过校验() {
        assert!(check("").is_ok());
        assert!(check("# 只有注释\n").is_ok());
        assert!(check("version: 1\n").is_ok());
        assert!(check("version: 1\nrefs: {}\n").is_ok());
    }

    #[test]
    fn 旧版扁平格式放行由dsh自动迁移() {
        assert!(check("DEEPSEEK_API_KEY: sk-abc\n").is_ok());
    }

    #[test]
    fn 扁平格式含非字符串值不放行() {
        let doc = "DEEPSEEK_API_KEY: sk-abc\nPORT: 3000\n";
        assert!(check(doc).is_err());
    }

    #[test]
    fn 字符串版本号不兼容() {
        let doc = "version: \"1\"\nrefs:\n  DEEPSEEK_API_KEY: sk-abc\n";
        assert!(check(doc).is_err());
    }

    #[test]
    fn refs非字符串值不兼容() {
        let doc = "version: 1\nrefs:\n  PORT: 3000\n";
        assert!(check(doc).is_err());
    }

    #[test]
    fn 未知顶层键不兼容() {
        let doc = "version: 1\nfoo: bar\n";
        assert!(check(doc).is_err());
    }

    #[test]
    fn refs是序列不兼容() {
        let doc = "version: 1\nrefs:\n- DEEPSEEK_API_KEY: sk-abc\n";
        assert!(check(doc).is_err());
    }

    #[test]
    fn 打码不泄露完整值() {
        let masked = mask_content("version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-abcdef\n");
        assert!(masked.contains("sk-a****"));
        assert!(!masked.contains("sk-abcdef"));
        assert!(masked.contains("version: 1"));
        // 短值整体打码
        let m2 = mask_content("refs:\n  KEY: ab\n");
        assert!(m2.contains("****"));
        // 引号外壳保留
        let m3 = mask_content("refs:\n  KEY: \"sk-abcdef\"\n");
        assert!(m3.contains("\"sk-a****\""));
    }

    #[test]
    fn 修复扁平文档生成规范格式() {
        let (refs, records, dropped) = extract_document("DEEPSEEK_API_KEY: sk-abc\n").unwrap();
        assert_eq!(dropped, 0);
        assert_eq!(refs.len(), 1);
        assert!(records.is_empty());
        assert!(refs
            .get(Value::String("DEEPSEEK_API_KEY".into()))
            .is_some());
    }

    #[test]
    fn 修复损坏的flow文档走逐行兜底() {
        // `{` 顶格 + flow 段缺逗号 → YAML 无法解析，逐行扫描仍能恢复
        let text = "version: 1\nrefs:\n{\n  DEEPSEEK_API_KEY: sk-abc\n}\n";
        let (refs, _, dropped) = extract_document(text).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(dropped, 0);
    }

    #[test]
    fn 修复时移除空值条目并保留其余() {
        let (refs, _, dropped) =
            extract_document("version: 1\nrefs:\n  KEY1: sk-abc\n  KEY2:\n").unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(dropped, 1);
    }

    #[test]
    fn 非字符串ref值修复为字符串() {
        let (refs, _, dropped) = extract_document("version: 1\nrefs:\n  PORT: 3000\n").unwrap();
        assert_eq!(dropped, 0);
        assert_eq!(
            refs.get(Value::String("PORT".into())),
            Some(&Value::String("3000".into()))
        );
    }

    #[test]
    fn 无法识别的内容返回错误() {
        assert!(extract_document("!!!\n").is_err());
        assert!(extract_document("just some text without colons\n").is_err());
    }

    /// 命令级端到端：check → 打码展示 → fix → 再次 check。用临时 DSH_HOME 隔离，
    /// 绝不触碰用户的真实凭据文件。注意：本测试会修改进程环境变量，
    /// 因此必须串行执行（Rust 2021 无并行隔离），且本模块内其他用例不读 DSH_HOME。
    #[test]
    fn 命令级检查修复链路() {
        let dir = std::env::temp_dir().join(format!("cred-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("DSH_HOME", &dir);
        let path = dir.join(".credentials.yaml");

        // ① 文件不存在 → 兼容（空凭据库）
        let c = check_credentials_compat().unwrap();
        assert!(c.compatible);

        // ② 旧版扁平格式 → 兼容（dsh 启动时会自动原地迁移，无需弹框）
        std::fs::write(&path, "DEEPSEEK_API_KEY: sk-abc\n").unwrap();
        let c = check_credentials_compat().unwrap();
        assert!(c.compatible, "扁平格式应兼容: {:?}", c.reason);

        // ③ 字符串版本号 → 不兼容：打码内容不泄露完整值；修复后为规范格式并再次通过
        std::fs::write(&path, "version: \"1\"\nrefs:\n  DEEPSEEK_API_KEY: sk-abcdef\n").unwrap();
        let c = check_credentials_compat().unwrap();
        assert!(!c.compatible);
        let masked = c.masked_content.as_deref().unwrap();
        assert!(!masked.contains("sk-abcdef"), "打码内容不应含完整值");
        assert!(masked.contains("sk-a****"));
        assert!(c.template.is_some());
        let summary = fix_credentials().unwrap();
        assert!(summary.contains("已更新为最新格式"));
        let fixed = std::fs::read_to_string(&path).unwrap();
        assert!(fixed.starts_with("version: 1\n"), "修复后应为规范版本号: {fixed}");
        assert!(fixed.contains("DEEPSEEK_API_KEY: sk-abcdef"), "凭据值应保留");
        assert!(check_credentials_compat().unwrap().compatible, "修复后应通过检查");

        // ④ 无法识别的内容 → 修复拒绝且不覆盖文件
        std::fs::write(&path, "!!!\n").unwrap();
        assert!(fix_credentials().is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "!!!\n");

        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("DSH_HOME");
    }
}
