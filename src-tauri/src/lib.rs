use std::{env, fs, path::PathBuf};
use tauri::Manager;

const LOCAL_API_URL: &str = "http://127.0.0.1:53117";

fn api_url_from_json(text: &str) -> Option<String> {
    for key in [
        "apiBase",
        "API_BASE_URL",
        "apiBaseUrl",
        "eciApiBaseUrl",
        "ECI_API_BASE_URL",
    ] {
        if let Some((_, tail)) = text.split_once(&format!("\"{key}\"")) {
            let value = tail.split_once(':')?.1.trim_start();
            if let Some(value) = value.strip_prefix('"').and_then(|v| v.split('"').next()) {
                return Some(value.trim_end_matches('/').to_string());
            }
        }
    }
    None
}

fn allowed_api_url(value: &str) -> bool {
    let safe_chars = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || ":/?#[]@!$&'()*+,-._~=%".contains(c));
    let protocol_allowed = value.starts_with("https://")
            || value.starts_with("http://127.0.0.1:")
            || value.starts_with("http://localhost:")
            || value.starts_with("http://[::1]:");
    let authority = value.split_once("://").map(|(_, rest)| rest).unwrap_or("");
    safe_chars
        && protocol_allowed
        && !authority.contains('@')
        && !authority.contains('?')
        && !authority.contains('#')
        && !authority.contains('/')
}

fn configured_api_url(config_dir: PathBuf, resource_dir: PathBuf) -> String {
    let mut candidates = Vec::new();
    if let Ok(value) = env::var("ECI_API_BASE_URL") {
        candidates.push(value);
    }
    let user_file = config_dir.join("bessforge.config.json");
    let user_file_exists = user_file.exists();
    if let Ok(text) = fs::read_to_string(&user_file) {
        if let Some(value) = api_url_from_json(&text) {
            candidates.push(value);
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Ok(text) = fs::read_to_string(parent.join("bessforge.config.json")) {
                if let Some(value) = api_url_from_json(&text) {
                    candidates.push(value);
                }
            }
        }
    }
    if let Ok(text) = fs::read_to_string(resource_dir.join("bessforge.config.json")) {
        if let Some(value) = api_url_from_json(&text) {
            candidates.push(value);
        }
    }
    let selected = candidates
        .into_iter()
        .find(|value| allowed_api_url(value))
        .unwrap_or_else(|| LOCAL_API_URL.to_string());
    if !user_file_exists {
        let _ = fs::create_dir_all(&config_dir);
        let _ = fs::write(
            &user_file,
            format!("{{\n  \"apiBase\": \"{selected}\"\n}}\n"),
        );
    }
    selected
}

// BESSForge desktop shell: bundled UI plus narrowly scoped save support.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let api_url =
                configured_api_url(app.path().app_config_dir()?, app.path().resource_dir()?);
            if let Some(window) = app.get_webview_window("main") {
                // URL validation excludes quotes/backslashes, making this literal safe.
                window.eval(&format!(
                    "window.__BESSFORGE_CONFIG__=window.__ECI_CONFIG__=Object.freeze({{apiBase:\"{api_url}\",API_BASE_URL:\"{api_url}\"}})"
                ))?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running BESSForge");
}
