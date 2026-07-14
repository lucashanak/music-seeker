use tauri::Manager;
use std::process::Command;

#[cfg(desktop)]
#[tauri::command]
async fn install_macos_update(url: String) -> Result<String, String> {
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    let tmp_dir = std::env::temp_dir().join("musicseeker-update");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    // Download DMG
    let dmg_path = tmp_dir.join("MusicSeeker.dmg");
    let output = Command::new("curl")
        .args(["-fSL", "-o", dmg_path.to_str().unwrap(), &url])
        .output()
        .map_err(|e| format!("Download failed: {}", e))?;
    if !output.status.success() {
        return Err(format!("Download failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    // Mount DMG silently
    let output = Command::new("hdiutil")
        .args(["attach", "-nobrowse", dmg_path.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Mount failed: {}", e))?;
    let attach_output = String::from_utf8_lossy(&output.stdout);
    let mount_point = attach_output
        .lines()
        .filter_map(|line| {
            let idx = line.find("/Volumes/")?;
            Some(line[idx..].trim().to_string())
        })
        .last()
        .ok_or("Could not find mount point in hdiutil output")?;

    // Find .app bundle
    let entries = fs::read_dir(&mount_point).map_err(|e| e.to_string())?;
    let app_bundle = entries
        .filter_map(|e| e.ok())
        .find(|e| e.file_name().to_string_lossy().ends_with(".app"))
        .ok_or("No .app found in DMG")?;
    let app_name = app_bundle.file_name();
    let dest = PathBuf::from("/Applications").join(&app_name);

    // Copy to /Applications with ditto (atomic overwrite)
    let status = Command::new("ditto")
        .args([app_bundle.path().to_str().unwrap(), dest.to_str().unwrap()])
        .status()
        .map_err(|e| format!("Copy failed: {}", e))?;
    if !status.success() {
        let _ = Command::new("hdiutil").args(["detach", &mount_point, "-quiet"]).status();
        return Err("ditto copy failed".to_string());
    }

    // Remove quarantine attribute
    let _ = Command::new("xattr")
        .args(["-cr", dest.to_str().unwrap()])
        .status();

    // Detach DMG
    let _ = Command::new("hdiutil")
        .args(["detach", &mount_point, "-quiet"])
        .status();

    // Create relaunch script
    let pid = std::process::id();
    let script_path = tmp_dir.join("relaunch.sh");
    let mut script = fs::File::create(&script_path).map_err(|e| e.to_string())?;
    write!(
        script,
        "#!/bin/bash\nwhile kill -0 {} 2>/dev/null; do sleep 0.5; done\nopen '{}'\n",
        pid,
        dest.to_str().unwrap()
    )
    .map_err(|e| e.to_string())?;

    // Make executable and launch
    let _ = Command::new("chmod").args(["+x", script_path.to_str().unwrap()]).status();
    let _ = Command::new("/bin/bash")
        .arg(script_path.to_str().unwrap())
        .spawn();

    // Exit process — relaunch script will open new version
    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK 2.42+ ships a DMABUF-based renderer that produces a BLANK window
    // on many Linux setups — software rendering (llvmpipe/swrast), NVIDIA proprietary
    // drivers, VMs, and some Mesa versions — because the GPU-buffer path it assumes
    // isn't available. The webview subprocess reads this env var when it spawns (during
    // Builder::run below), so setting it here — before the webview is created, and
    // regardless of how the AppImage was launched (double-click, .desktop, terminal) —
    // forces the reliable non-DMABUF path. No effect on macOS/Windows (WKWebView/WebView2).
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.invoke_handler(tauri::generate_handler![install_macos_update]);
    }

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

                let reload = MenuItemBuilder::with_id("reload", "Reload")
                    .accelerator("CmdOrCtrl+R")
                    .build(app)?;
                let hard_reload = MenuItemBuilder::with_id("hard_reload", "Hard Reload")
                    .accelerator("CmdOrCtrl+Shift+R")
                    .build(app)?;
                let clear_cache = MenuItemBuilder::with_id("clear_cache", "Clear Cache & Reload")
                    .accelerator("CmdOrCtrl+Shift+Delete")
                    .build(app)?;

                let view_menu = SubmenuBuilder::new(app, "View")
                    .item(&reload)
                    .item(&hard_reload)
                    .separator()
                    .item(&clear_cache)
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .copy()
                    .paste()
                    .select_all()
                    .item(&view_menu)
                    .build()?;

                app.set_menu(menu)?;

                app.on_menu_event(move |app, event| {
                    let id = event.id().as_ref();
                    if let Some(window) = app.get_webview_window("main") {
                        match id {
                            "reload" => {
                                let _ = window.eval("location.reload();");
                            }
                            "hard_reload" => {
                                let _ = window.eval("location.reload(true);");
                            }
                            "clear_cache" => {
                                let _ = window.eval(
                                    "window.localStorage.clear(); window.sessionStorage.clear(); \
                                     caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))).then(() => location.reload(true));"
                                );
                            }
                            _ => {}
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
