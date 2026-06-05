#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

struct ServerState {
    url: Mutex<Option<String>>,
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

/// Kill any process already holding the server port (e.g. a zombie from a
/// previous launch that Tauri didn't clean up).
fn free_port(port: u16) {
    let port_str = port.to_string();
    if let Ok(out) = std::process::Command::new("lsof")
        .args(["-ti", &format!(":{port_str}")])
        .output()
    {
        if let Ok(pids) = String::from_utf8(out.stdout) {
            for pid in pids.lines().filter(|l| !l.is_empty()) {
                let _ = std::process::Command::new("kill")
                    .args(["-9", pid])
                    .output();
            }
        }
    }
}

#[tauri::command]
async fn start_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, ServerState>,
    password: String,
) -> Result<String, String> {
    // If we already know the URL, reuse it
    if let Some(url) = state.url.lock().unwrap().as_ref() {
        return Ok(url.clone());
    }

    // Kill any previous child process to free the port
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    free_port(3000);

    // Resolve the bundled admin UI path from app resources
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let admin_ui_path = resource_dir.join("admin-ui");

    let shell = app.shell();

    let sidecar = shell
        .sidecar("swarm-server")
        .map_err(|e| format!("Sidecar not found: {}", e))?
        .args([
            &format!("--password={}", password),
            &format!("--admin-ui-path={}", admin_ui_path.display()),
        ]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Spawn failed: {}", e))?;

    *state.child.lock().unwrap() = Some(child);

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut port: u16 = 3000;

    while let Some(event) = rx.recv().await {
        match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                stdout_buf.push_str(&text);
                if let Some(url_line) = stdout_buf
                    .lines()
                    .find(|l| l.contains("Server running at"))
                {
                    if let Some(rest) = url_line.split("localhost:").nth(1) {
                        port = rest
                            .split_whitespace()
                            .next()
                            .unwrap_or("3000")
                            .parse()
                            .unwrap_or(3000);
                    }
                    break;
                }
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                stderr_buf.push_str(&text);
                if let Some(url_line) = stderr_buf
                    .lines()
                    .find(|l| l.contains("Server running at"))
                {
                    if let Some(rest) = url_line.split("localhost:").nth(1) {
                        port = rest
                            .split_whitespace()
                            .next()
                            .unwrap_or("3000")
                            .parse()
                            .unwrap_or(3000);
                    }
                    break;
                }
            }
            tauri_plugin_shell::process::CommandEvent::Error(err) => {
                return Err(format!("Server error: {}", err));
            }
            tauri_plugin_shell::process::CommandEvent::Terminated(status) => {
                let code = status.code.unwrap_or(-1);
                let detail = if !stderr_buf.is_empty() {
                    stderr_buf.clone()
                } else {
                    stdout_buf.clone()
                };
                return Err(format!(
                    "Server exited with code {}\n{}",
                    code,
                    detail
                ));
            }
            _ => {}
        }
    }

    let url = format!("http://localhost:{}", port);
    *state.url.lock().unwrap() = Some(url.clone());
    Ok(url)
}

#[tauri::command]
fn get_server_url(state: tauri::State<'_, ServerState>) -> Option<String> {
    state.url.lock().unwrap().clone()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(ServerState {
                url: Mutex::new(None),
                child: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![start_server, get_server_url])
        .run(tauri::generate_context!())
        .expect("error while running Swarm Desktop");
}
