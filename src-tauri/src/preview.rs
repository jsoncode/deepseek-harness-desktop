//! 原生预览子 webview：把宿主（dsh web）页面作为「顶层文档」放进与桌面壳同窗口的
//! 子 webview，位置精确对齐内容区（顶栏之下、底栏之上），桌面壳的顶栏/底栏等
//! DOM 界面保持原样可见可操作。
//!
//! # 为什么必须是「顶层」
//!
//! 打包正式版里壳顶层页面来自自定义协议（tauri://localhost），宿主新版认证通过
//! 「root 请求换 SameSite=Strict 会话 Cookie」完成，而 Strict Cookie 只随
//! 【同站 / 顶层】请求携带：DOM iframe 相对 tauri://localhost 是跨站，换来的
//! Cookie 永远发不回 → 页面停在 `dsh web authentication required`。子 webview 的
//! 顶层文档就是宿主地址本身（http://127.0.0.1:<port>），认证链路与系统浏览器一致。
//!
//! # 平台
//!
//! 子 webview 用 Tauri unstable 多 webview API（`Window::add_child` +
//! `tauri::webview::WebviewBuilder`）实现。目前仅 Windows 启用（
//! `preview_native_supported()` 返回 true）；macOS/Linux 暂退回 iframe 方案。

use std::sync::Mutex;
use tauri::{AppHandle, Manager};

type PreviewWebview = tauri::webview::Webview<tauri::Wry>;

/// 当前预览子 webview（None = 未创建）
static PREVIEW: Mutex<Option<PreviewWebview>> = Mutex::new(None);

/// 是否支持原生子 webview 预览（目前仅 Windows 打包正式版真正需要）
#[tauri::command]
pub fn preview_native_supported() -> bool {
    cfg!(target_os = "windows")
}

/// 在内容区显示/更新宿主页（幂等：已存在则导航 + 重定位，不存在则创建）。
/// 前端在 url/进入预览/刷新时调用。
#[tauri::command]
pub async fn preview_show(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        imp::show(&app, &url, x, y, width, height)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, url, x, y, width, height);
        Ok(())
    }
}

/// 内容区位置/尺寸变化时（窗口缩放、最大化/还原等）同步子 webview 边界
#[tauri::command]
pub async fn preview_resize(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        imp::resize(x, y, width, height)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, width, height);
        Ok(())
    }
}

/// 离开预览页 / 停止服务时销毁子 webview
#[tauri::command]
pub async fn preview_hide() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        imp::hide()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

    fn apply_bounds(wv: &PreviewWebview, x: f64, y: f64, width: f64, height: f64) {
        // CSS px 即逻辑像素：前端直接汇报 getBoundingClientRect 结果
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width, height));
    }

    pub fn show(
        app: &AppHandle,
        url: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        let parsed = tauri::Url::parse(url).map_err(|e| format!("无效的服务地址: {e}"))?;
        let mut slot = PREVIEW.lock().unwrap();
        if let Some(wv) = slot.as_ref() {
            let _ = wv.navigate(parsed);
            apply_bounds(wv, x, y, width, height);
            return Ok(());
        }
        let window = app.get_window("main").ok_or("未找到主窗口")?;
        let builder = tauri::webview::WebviewBuilder::new("preview", WebviewUrl::External(parsed));
        // add_child 内部会切回主线程执行，必须在非主线程调用（async 命令满足）
        let wv = window
            .add_child(
                builder,
                LogicalPosition::new(x, y),
                LogicalSize::new(width, height),
            )
            .map_err(|e| format!("创建预览子 webview 失败: {e}"))?;
        // 再次应用边界：规避 WebView2 首帧把子 webview 卡在离屏 1×1 的问题
        apply_bounds(&wv, x, y, width, height);
        *slot = Some(wv);
        Ok(())
    }

    pub fn resize(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
        if let Some(wv) = PREVIEW.lock().unwrap().as_ref() {
            apply_bounds(wv, x, y, width, height);
        }
        Ok(())
    }

    pub fn hide() -> Result<(), String> {
        if let Some(wv) = PREVIEW.lock().unwrap().take() {
            let _ = wv.close();
        }
        Ok(())
    }
}
