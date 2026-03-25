#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WebviewUrl};

#[tauri::command]
fn clear_cache(app: tauri::AppHandle) {
    // Close current window and reopen with cache-busted URL
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(
            "window.localStorage.clear(); window.sessionStorage.clear(); \
             caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))).then(() => location.reload(true));"
        );
    }
}

#[tauri::command]
fn hard_reload(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("location.reload(true);");
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![clear_cache, hard_reload])
        .setup(|app| {
            // Register keyboard shortcuts
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
