fn main() {
    // Declaring commands here is what makes them grantable to a REMOTE origin.
    // Registering a command with invoke_handler allows it for the app's own
    // (local) webviews only; the page we actually load is served from the
    // configured server, so every call was rejected with
    // "Command <name> not allowed by ACL" until these were declared and then
    // granted in capabilities/.
    //
    // Each name generates `allow-$command` / `deny-$command` permissions, and
    // declaring the list means ONLY these are available — so it has to be
    // complete.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "install_macos_update",
                "install_linux_update",
                "open_external",
                "set_server_url",
                "reset_server_url",
                "current_server_url",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
