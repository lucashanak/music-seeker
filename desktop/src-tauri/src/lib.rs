use tauri::Manager;
use std::process::Command;

// ── Configurable server address ─────────────────────────────────────
// The app is a thin wrapper around a MusicSeeker instance, and until now that
// instance was hardcoded in three places (window URL, dist/index.html, the IPC
// capability), so the published builds only worked against the author's server.
// It is now a DEFAULT rather than a hardcode: with nothing stored the app behaves
// exactly as before — same window, same URL, same static capability, no extra
// step — and a self-hoster can point it at their own instance instead.
const DEFAULT_SERVER_URL: &str = "https://musicseeker.hanaktech.org";

/// Where the chosen server is remembered. The app config dir rather than
/// localStorage: it must be readable before any page loads, and it has to
/// survive both "Clear Cache & Reload" (View menu) and an APK/DMG update.
fn server_url_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("server_url"))
}

/// The server the user configured, if any. Plain text, not JSON — one value,
/// and it keeps serde_json out of the dependency list.
fn stored_server_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    let raw = std::fs::read_to_string(server_url_file(app)?).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

/// Reject anything that is not a plain https origin.
///
/// https only, deliberately: Android blocks cleartext traffic by default, so an
/// http:// address would load a blank page with no explanation. Better to refuse
/// it here with a message the setup page can show.
fn validate_server_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    if !url.starts_with("https://") {
        return Err("The address must start with https:// — Android blocks plain http.".into());
    }
    let host = &url["https://".len()..];
    if host.is_empty() || host.contains('/') || host.contains(' ') {
        return Err("Enter just the address, e.g. https://music.example.com".into());
    }
    Ok(url.to_string())
}

/// Let the configured server use the IPC bridge.
///
/// Capabilities are baked in at build time, so a runtime address cannot be in
/// capabilities/default.json. Manager::add_capability adds one scoped to exactly
/// the address the user entered — no wildcard, so nothing else gains access, and
/// the in-app updater keeps working on a self-hosted instance too.
fn grant_server_ipc<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &str) {
    let capability = tauri::ipc::CapabilityBuilder::new("configured-server")
        .remote(format!("{}/*", url.trim_end_matches('/')))
        .window("main")
        .permission("core:default");
    if let Err(e) = app.add_capability(capability) {
        eprintln!("MusicSeeker: could not grant IPC to {url}: {e}");
    }
}

/// Build the main window pointing at `url`.
///
/// Created, not navigated: the app version travels to the frontend as a query
/// param (the update banner and every cache-busting reload read it back), and
/// capability matching on the *initial* URL is the documented behaviour whereas
/// matching after a client-side navigation is not.
fn open_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &str) -> tauri::Result<()> {
    let target = format!(
        "{}/?app_version={}",
        url.trim_end_matches('/'),
        app.package_info().version
    );
    if let Some(existing) = app.get_webview_window("main") {
        let _ = existing.destroy();
    }
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External(target.parse().expect("server url should parse")),
    )
    .title("MusicSeeker")
    .inner_size(1200.0, 800.0)
    .min_inner_size(400.0, 600.0);

    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);

    builder.build()?;
    Ok(())
}

/// Show the bundled setup page (desktop/dist/index.html).
fn open_setup_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window("main") {
        let _ = existing.destroy();
    }
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("MusicSeeker")
        .inner_size(560.0, 620.0)
        .min_inner_size(400.0, 520.0)
        .build()?;
    Ok(())
}

/// Called by the setup page once the address has answered /api/version.
#[tauri::command]
fn set_server_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = validate_server_url(&url)?;
    let path = server_url_file(&app).ok_or("No config directory available")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &url).map_err(|e| e.to_string())?;
    grant_server_ipc(&app, &url);
    open_main_window(&app, &url).map_err(|e| e.to_string())
}

/// Forget the configured server and go back to the setup page. Reachable from
/// the failed-login hint in the web app and from the macOS View menu — someone
/// who typed the wrong address needs a way back that is not "reinstall".
#[tauri::command]
fn reset_server_url(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(path) = server_url_file(&app) {
        let _ = std::fs::remove_file(path);
    }
    open_setup_window(&app).map_err(|e| e.to_string())
}

/// The address the app is pointing at, for the setup page to prefill.
#[tauri::command]
fn current_server_url(app: tauri::AppHandle) -> String {
    stored_server_url(&app).unwrap_or_else(|| DEFAULT_SERVER_URL.to_string())
}

/// Hand a release download to the system browser.
///
/// `window.location.href = <binary url>` is what the web app used to do, and it
/// cannot work inside a webview: there is no download manager, so it either does
/// nothing or navigates the app away from itself. The clipboard fallback was
/// gated to Android, which left desktop users with a button that silently did
/// nothing.
///
/// Restricted to this project's release URLs on purpose. Any origin holding IPC
/// can call this, so it must not become a general "open any URL" primitive.
/// In-app update for Linux.
///
/// Two install shapes exist and they need different handling, so the choice is
/// made here rather than in the page — the page cannot see the filesystem, and
/// keeping the decision next to the install means the asset and the method can
/// never disagree:
///
/// * **Portable binary** (`MusicSeeker-linux`, wherever the user put it): the new
///   binary is written beside the old one and `rename`d over it. Overwriting a
///   running executable by opening it for writing fails with ETXTBSY, but
///   replacing the directory entry does not — the running process keeps its
///   inode and survives, verified on Linux before this was written. No polkit,
///   no privileges, no prompt.
/// * **Distro package** (`/usr/bin/music-seeker` from the pacman package): root
///   owns it, so the package is handed to a graphical installer which raises its
///   own polkit prompt. Same approach claude-remote takes.
///
/// Takes no URL, unlike install_macos_update: a page-supplied URL means any
/// origin holding IPC can choose what gets installed. The asset is derived from
/// the install shape and fetched from the fixed releases path.
#[cfg(target_os = "linux")]
#[tauri::command]
fn install_linux_update() -> Result<String, String> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    const RELEASES: &str = "https://github.com/lucashanak/music-seeker/releases/latest/download";

    let exe = std::env::current_exe().map_err(|e| format!("Cannot locate the app: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "The app has no parent directory".to_string())?
        .to_path_buf();

    // rename() needs write permission on the DIRECTORY, not on the file, so
    // that is what decides which path we are on.
    let portable = {
        let probe = dir.join(".musicseeker-write-probe");
        match fs::File::create(&probe) {
            Ok(_) => {
                let _ = fs::remove_file(&probe);
                true
            }
            Err(_) => false,
        }
    };

    let tmp_dir = std::env::temp_dir().join("musicseeker-update");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    if !portable {
        // Packaged install: fetch the pacman package and let a GUI installer
        // prompt for authorisation.
        let pkg = tmp_dir.join("music-seeker.pkg.tar.zst");
        download(&format!("{RELEASES}/MusicSeeker-manjaro-x86_64.pkg.tar.zst"), &pkg)?;
        // Bound to locals with .as_str(): `&[&format!(..)]` is `&[&String; 1]`,
        // which does not coerce to the `&[&str]` the helper takes.
        let path = pkg.to_string_lossy().to_string();
        let gnome_arg = format!("--local-filename={path}");
        let launched = try_spawn("pamac-installer", &[path.as_str()])
            || try_spawn("gnome-software", &[gnome_arg.as_str()])
            || try_spawn("xdg-open", &[path.as_str()]);
        if launched {
            return Ok("installer".into());
        }
        let _ = try_spawn(
            "xdg-open",
            &["https://github.com/lucashanak/music-seeker/releases/latest"],
        );
        return Err("No package installer found — opened the releases page instead".into());
    }

    // Portable install: swap the binary underneath ourselves and relaunch.
    let staged: PathBuf = dir.join(".MusicSeeker.new");
    download(&format!("{RELEASES}/MusicSeeker-linux"), &staged)?;

    let meta = fs::metadata(&staged).map_err(|e| e.to_string())?;
    if meta.len() < 1_000_000 {
        let _ = fs::remove_file(&staged);
        return Err("Downloaded file is too small to be the app — aborting".into());
    }
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    // Same directory, so this is an atomic replace on one filesystem.
    fs::rename(&staged, &exe).map_err(|e| format!("Could not replace the app: {e}"))?;

    relaunch_after_exit(&exe)?;
    std::process::exit(0);
}

#[cfg(target_os = "linux")]
fn try_spawn(program: &str, args: &[&str]) -> bool {
    Command::new(program).args(args).spawn().is_ok()
}

/// curl rather than an HTTP crate: it is already how the macOS updater fetches,
/// and it keeps the dependency list unchanged.
#[cfg(target_os = "linux")]
fn download(url: &str, dest: &std::path::Path) -> Result<(), String> {
    // Bound to a String first: an array literal must be homogeneous, and
    // `&dest.to_string_lossy()` is `&Cow<str>`, not `&str`.
    let dest_arg = dest.to_string_lossy().to_string();
    let out = Command::new("curl")
        .args(["-fSL", "-o", dest_arg.as_str(), url])
        .output()
        .map_err(|e| format!("Download failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "Download failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

/// Wait for this process to exit, then start the (already replaced) binary.
#[cfg(target_os = "linux")]
fn relaunch_after_exit(exe: &std::path::Path) -> Result<(), String> {
    use std::io::Write;
    let script = std::env::temp_dir().join("musicseeker-relaunch.sh");
    let mut f = std::fs::File::create(&script).map_err(|e| e.to_string())?;
    write!(
        f,
        "#!/bin/bash
while kill -0 {} 2>/dev/null; do sleep 0.5; done
exec '{}'
",
        std::process::id(),
        exe.to_string_lossy()
    )
    .map_err(|e| e.to_string())?;
    let script_arg = script.to_string_lossy().to_string();
    let _ = Command::new("chmod").args(["+x", script_arg.as_str()]).status();
    Command::new("/bin/bash")
        .arg(&script_arg)
        .spawn()
        .map_err(|e| format!("Could not schedule the relaunch: {e}"))?;
    Ok(())
}


#[cfg(desktop)]
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    const RELEASES: &str = "https://github.com/lucashanak/music-seeker/releases/";
    if !url.starts_with(RELEASES) {
        return Err("Refusing to open a URL outside the project's releases".into());
    }
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "windows")]
    let program = "explorer";

    Command::new(program)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the browser: {e}"))
}


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

    // invoke_handler REPLACES the handler rather than adding to it, so each
    // target gets exactly one call with its complete command list. Calling it
    // twice compiles cleanly and silently drops the first set at runtime.
    #[cfg(all(desktop, target_os = "linux"))]
    {
        builder = builder.invoke_handler(tauri::generate_handler![
            install_macos_update,
            install_linux_update,
            open_external,
            set_server_url,
            reset_server_url,
            current_server_url
        ]);
    }
    #[cfg(all(desktop, not(target_os = "linux")))]
    {
        builder = builder.invoke_handler(tauri::generate_handler![
            install_macos_update,
            open_external,
            set_server_url,
            reset_server_url,
            current_server_url
        ]);
    }
    #[cfg(not(desktop))]
    {
        builder = builder.invoke_handler(tauri::generate_handler![
            set_server_url,
            reset_server_url,
            current_server_url
        ]);
    }

    builder
        .setup(|app| {
            // Window creation moved out of tauri.conf.json because its URL is
            // runtime data. No stored address -> DEFAULT_SERVER_URL, which is the
            // pre-existing behaviour, and the static capability already covers it.
            let handle = app.handle().clone();
            match stored_server_url(&handle) {
                Some(url) => {
                    grant_server_ipc(&handle, &url);
                    open_main_window(&handle, &url)?;
                }
                None => open_main_window(&handle, DEFAULT_SERVER_URL)?,
            }

            // macOS ONLY: this menu lives in the global top-of-screen menu bar there,
            // which is expected. On Linux/Windows the same call renders an in-WINDOW
            // menu bar (an ugly "copy / paste / select all / view" strip inside the
            // app), so we don't attach it off macOS. Reload/clear-cache stay reachable
            // via the browser's own shortcuts (F5 etc.) on those platforms.
            #[cfg(target_os = "macos")]
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
                // Second way back to the setup page, for the case the web app
                // cannot offer one — a stored address that no longer resolves
                // never renders a login screen to click "change address" on.
                let change_server = MenuItemBuilder::with_id("change_server", "Change Server…")
                    .build(app)?;

                let view_menu = SubmenuBuilder::new(app, "View")
                    .item(&reload)
                    .item(&hard_reload)
                    .separator()
                    .item(&clear_cache)
                    .separator()
                    .item(&change_server)
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
                    if id == "change_server" {
                        if let Err(e) = reset_server_url(app.clone()) {
                            eprintln!("MusicSeeker: could not open server setup: {e}");
                        }
                        return;
                    }
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
