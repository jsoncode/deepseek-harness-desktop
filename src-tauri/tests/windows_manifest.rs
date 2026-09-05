//! 守住 build.rs 的测试清单嵌入：本包的 cargo test 依赖测试 exe 内嵌
//! Common-Controls v6 清单（根因见 build.rs embed_test_manifest 的注释）。
//! tauri 升级或构建方式变化导致清单缺失时，lib 单测会先于本测试在启动阶段
//! 就崩（0xc0000139），此文件的存在本身也是 rustc-link-arg-tests 的生效前提。

use std::process::Command;

#[test]
fn test_exe_has_common_controls_manifest() {
    let exe = std::env::current_exe().unwrap();
    let bytes = std::fs::read(&exe).unwrap();
    assert!(
        bytes.windows("Common-Controls".len()).any(|w| w == b"Common-Controls"),
        "测试 exe {} 缺少 Common-Controls 清单：lib 单测将无法启动（STATUS_ENTRYPOINT_NOT_FOUND），\
         请检查 build.rs 的 embed_test_manifest",
        exe.display(),
    );
}

#[test]
fn test_exe_can_spawn_children() {
    // 顺带验证测试进程能正常拉起子进程（tts 桩 worker 联调依赖此能力）
    let out = Command::new(std::env::current_exe().unwrap())
        .arg("--list")
        .output()
        .unwrap();
    assert!(out.status.success());
}
