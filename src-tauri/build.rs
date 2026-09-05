fn main() {
    // Windows 清单不再交给 tauri-build（它经 rustc-link-arg-bins 只嵌给 bin），
    // 改用无目标限制的 rustc-link-arg 统一嵌入 bin/cdylib/测试 exe：tauri 2.11
    // 默认启用 muda/common-controls-v6，其代码导入的 TaskDialogIndirect 仅存在于
    // v6 版 comctl32；测试 exe 没有清单会解析到 System32 的 comctl32 5.82，进程
    // 启动即 STATUS_ENTRYPOINT_NOT_FOUND（0xc0000139），cargo test 全体崩溃。
    // 图标/版本信息仍由 tauri-build 的 resource.lib 提供（见 tests/windows_manifest.rs 回归守卫）。
    #[cfg(target_os = "windows")]
    {
        let path = std::path::Path::new(&std::env::var("OUT_DIR").unwrap())
            .join("test-app-manifest.xml");
        std::fs::write(&path, TEST_MANIFEST).unwrap();
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", path.display());
        let attrs = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attrs).expect("failed to run tauri-build");
    }
    #[cfg(not(target_os = "windows"))]
    tauri_build::build();
}

#[cfg(target_os = "windows")]
const TEST_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;
