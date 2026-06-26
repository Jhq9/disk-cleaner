mod scanner;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::process::Command;
use tauri::{State, Emitter};

// Application state to share scanning handle and cancel flags across invocations
struct AppState {
    scan_state: Arc<scanner::ScanState>,
}

#[tauri::command]
fn get_disks() -> Vec<scanner::DiskStats> {
    scanner::get_disks()
}

#[tauri::command]
fn get_disk_info() -> Vec<scanner::DiskStats> {
    scanner::get_disks()
}

#[tauri::command]
async fn start_disk_scan(
    path: String,
    state: State<'_, AppState>,
    window: tauri::Window,
) -> Result<scanner::FileNode, String> {
    let scan_state = Arc::clone(&state.scan_state);
    
    // Halt any active scans first
    scan_state.is_running.store(false, Ordering::Relaxed);
    // Yield a short duration to let the previous threads exit safely
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    
    // Initialize state
    scan_state.reset();
    scan_state.is_running.store(true, Ordering::Relaxed);

    // Spawn a background timer task to stream progress events back to frontend
    let progress_state = Arc::clone(&scan_state);
    let progress_window = window.clone();
    let progress_handle = tauri::async_runtime::spawn(async move {
        while progress_state.is_running.load(Ordering::Relaxed) {
            let files = progress_state.files_scanned.load(Ordering::Relaxed);
            let bytes = progress_state.bytes_scanned.load(Ordering::Relaxed);
            let current = if let Ok(path) = progress_state.current_path.lock() {
                path.clone()
            } else {
                String::new()
            };

            let progress = scanner::ScanProgress {
                files_scanned: files,
                bytes_scanned: bytes,
                current_path: current,
                is_running: true,
            };

            // Emit progress event
            let _ = progress_window.emit("scan:progress", progress);
            tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
        }
    });

    let scan_path = std::path::PathBuf::from(&path);
    let run_state = Arc::clone(&scan_state);
    
    // Spawn heavy filesystem traversal on the blocking runtime
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Prune nodes under 2MB to keep tree render and payload optimized
        scanner::scan_directory(scan_path, 2_000_000, run_state)
    })
    .await;

    // Set scan status to finished and await progress loop termination
    scan_state.is_running.store(false, Ordering::Relaxed);
    let _ = progress_handle.await;

    match result {
        Ok(Some(node)) => {
            // Stream the final completed stats
            let files = scan_state.files_scanned.load(Ordering::Relaxed);
            let bytes = scan_state.bytes_scanned.load(Ordering::Relaxed);
            let _ = window.emit("scan:progress", scanner::ScanProgress {
                files_scanned: files,
                bytes_scanned: bytes,
                current_path: "扫描完成".to_string(),
                is_running: false,
            });
            Ok(node)
        }
        Ok(None) => {
            Err("扫描已取消或未发现可用文件。".to_string())
        }
        Err(e) => {
            Err(format!("扫描运行时遇到错误: {}", e))
        }
    }
}

#[tauri::command]
fn stop_disk_scan(state: State<'_, AppState>) -> Result<String, String> {
    state.scan_state.is_running.store(false, Ordering::Relaxed);
    Ok("扫描已成功中止。".to_string())
}

#[tauri::command]
fn delete_items(paths: Vec<String>) -> Result<(u64, Vec<String>), String> {
    scanner::delete_items(paths)
}

#[tauri::command]
fn migrate_folder(source: String, target_parent: String) -> Result<String, String> {
    scanner::migrate_directory(source, target_parent)
}

#[tauri::command]
fn get_migration_apps() -> Vec<scanner::MigrationApp> {
    scanner::get_migration_apps()
}

#[tauri::command]
fn get_installed_apps() -> Vec<scanner::InstalledApp> {
    scanner::get_installed_apps()
}

#[tauri::command]
async fn run_uninstaller(uninstall_string: String) -> Result<String, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new("cmd")
            .args(&["/C", &uninstall_string])
            .output();
        match output {
            Ok(o) if o.status.success() => Ok("卸载程序执行完毕。".to_string()),
            Ok(o) => {
                Ok(format!("卸载程序已启动 (退出码: {:?})", o.status.code()))
            }
            Err(e) => Err(format!("无法执行卸载命令: {}", e)),
        }
    })
    .await;

    match result {
        Ok(res) => res,
        Err(e) => Err(format!("线程执行错误: {}", e)),
    }
}

#[tauri::command]
fn scan_leftovers(app_name: String, publisher: String, install_location: String) -> scanner::Leftovers {
    scanner::scan_leftovers(app_name, publisher, install_location)
}

#[tauri::command]
fn clean_leftovers(files: Vec<String>, reg_keys: Vec<scanner::LeftoverRegistryKey>) -> Result<String, String> {
    scanner::clean_leftovers(files, reg_keys)
}

#[tauri::command]
fn get_tweak_status() -> Vec<serde_json::Value> {
    scanner::get_tweak_status()
}

#[tauri::command]
fn execute_tweak(id: String) -> Result<String, String> {
    scanner::execute_tweak(&id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(AppState {
      scan_state: Arc::new(scanner::ScanState::new()),
    })
    .invoke_handler(tauri::generate_handler![
      get_disks,
      get_disk_info,
      start_disk_scan,
      stop_disk_scan,
      delete_items,
      migrate_folder,
      get_installed_apps,
      run_uninstaller,
      scan_leftovers,
      clean_leftovers,
      get_tweak_status,
      execute_tweak,
      get_migration_apps
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
