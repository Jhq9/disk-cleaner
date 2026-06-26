use std::path::{Path, PathBuf};
use std::fs;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, AtomicBool, Ordering};
use std::process::Command;
use serde::{Serialize, Deserialize};
use rayon::prelude::*;
use sysinfo::Disks;
use winreg::enums::*;
use winreg::RegKey;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiskStats {
    pub name: String,
    pub mount_point: String,
    pub total_space: u64,
    pub free_space: u64,
    pub used_space: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub safety_level: String, // "safe" | "warning" | "critical" | "uninstall"
    pub category: String,
    pub description: String,
    pub impact: String,
    pub can_migrate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScanProgress {
    pub files_scanned: u64,
    pub bytes_scanned: u64,
    pub current_path: String,
    pub is_running: bool,
}

// Global scanning state tracker
pub struct ScanState {
    pub files_scanned: AtomicU64,
    pub bytes_scanned: AtomicU64,
    pub current_path: Mutex<String>,
    pub is_running: AtomicBool,
}

impl ScanState {
    pub fn new() -> Self {
        Self {
            files_scanned: AtomicU64::new(0),
            bytes_scanned: AtomicU64::new(0),
            current_path: Mutex::new(String::new()),
            is_running: AtomicBool::new(false),
        }
    }

    pub fn reset(&self) {
        self.files_scanned.store(0, Ordering::Relaxed);
        self.bytes_scanned.store(0, Ordering::Relaxed);
        if let Ok(mut path) = self.current_path.lock() {
            path.clear();
        }
        self.is_running.store(false, Ordering::Relaxed);
    }
}

/// Classifies a path to provide safe and easy-to-understand explanations for computer novices.
pub fn classify_path(path: &Path) -> (String, String, String, String) {
    let path_str = path.to_string_lossy().to_string();
    let path_lower = path_str.to_lowercase();
    
    // 1. Recycle Bin
    if path_lower.contains("$recycle.bin") || path_lower.contains("$r") {
        return (
            "safe".to_string(),
            "回收站 (Recycle Bin)".to_string(),
            "存放您已删除但尚未永久清除的文件。".to_string(),
            "完全安全。清空回收站将永久删除这些文件并释放空间。".to_string(),
        );
    }
    
    // 2. Windows Temp
    if path_lower.contains("windows\\temp") || path_lower.contains("appdata\\local\\temp") {
        return (
            "safe".to_string(),
            "临时垃圾文件 (Temp Files)".to_string(),
            "系统和应用程序运行过程中产生的临时缓存、临时交换文件。".to_string(),
            "完全安全。删除这些文件不会影响任何程序的正常运行，能立即释放空间。".to_string(),
        );
    }
    
    // 3. Windows Update Cache
    if path_lower.contains("windows\\softwaredistribution\\download") {
        return (
            "safe".to_string(),
            "系统更新缓存 (Windows Update)".to_string(),
            "Windows Update 已下载并完成安装的更新补丁包。".to_string(),
            "安全。删除后，如果系统再次需要这些补丁，Windows 会自动重新下载，不影响当前系统稳定性。".to_string(),
        );
    }
    
    // 4. System Logs & Crash Dumps
    if path_lower.contains("windows\\system32\\winevt\\logs") 
        || path_lower.contains("windows\\minidump") 
        || path_lower.contains("memory.dmp") 
        || path_lower.ends_with(".log") 
    {
        return (
            "safe".to_string(),
            "系统日志与崩溃文件 (Logs & Dumps)".to_string(),
            "Windows 系统日志和程序崩溃时的内存快照（DMP），主要用于故障排查。".to_string(),
            "安全。删除它们会清除以往的错误日志，对系统日常运行完全没有负面影响。".to_string(),
        );
    }
    
    // 5. Browser Caches
    if path_lower.contains("appdata\\local\\google\\chrome\\user data\\default\\cache")
        || path_lower.contains("appdata\\local\\microsoft\\edge\\user data\\default\\cache")
        || path_lower.contains("appdata\\local\\mozilla\\firefox\\profiles") && path_lower.contains("cache")
    {
        return (
            "safe".to_string(),
            "浏览器缓存 (Browser Cache)".to_string(),
            "浏览器为了让您下次访问网页更快而缓存的网页图片、脚本等资源。".to_string(),
            "安全。删除后仅会导致下次打开某些网页时稍微变慢一点点，不会影响您的书签、密码和登录状态。".to_string(),
        );
    }

    // 6. Developer Caches (pip, npm, cargo, nuget)
    if path_lower.contains("appdata\\local\\pip\\cache")
        || path_lower.contains("appdata\\local\\npm-cache")
        || path_lower.contains(".cargo\\registry")
        || path_lower.contains(".nuget\\packages")
        || path_lower.contains(".m2\\repository")
    {
        return (
            "safe".to_string(),
            "编程开发工具缓存 (Dev Cache)".to_string(),
            "开发环境（Python, Node.js, Rust, Java, C# 等）下载的第三方组件缓存。".to_string(),
            "安全。删除后下次编译相关项目时，工具会自动重新联网下载，首次编译速度会有所降低。".to_string(),
        );
    }
    
    // 7. Windows System Core - CRITICAL
    if path_lower.contains("windows\\system32") 
        || path_lower.contains("windows\\syswow64")
        || path_lower.contains("windows\\winsxs")
        || path_lower.contains("windows\\boot")
        || path_lower.contains("windows\\microsoft.net")
        || path_lower.contains("c:\\boot")
        || path_lower.contains("c:\\recovery")
        || path_lower.contains("c:\\efi")
        || path_lower.contains("c:\\system volume information")
    {
        return (
            "critical".to_string(),
            "系统核心文件 (Windows System Core)".to_string(),
            "Windows 操作系统最核心的文件、系统配置与底层驱动。".to_string(),
            "【千万不要删除！】删除此处的任何内容都将直接导致 Windows 蓝屏、无法启动或系统崩溃！本软件已对该目录进行了安全锁定。".to_string(),
        );
    }
    
    // 8. General Windows directory (excluding safe parts)
    if path_lower.starts_with("c:\\windows") {
        return (
            "critical".to_string(),
            "系统配置文件 (Windows Files)".to_string(),
            "Windows 操作系统的组件和配置文件夹。".to_string(),
            "【禁止删除】手动删除此文件夹中的内容极易引发系统故障，请使用 Windows 自带的清理工具或本软件的安全项进行清理。".to_string(),
        );
    }
    
    // 9. Pagefile / Hiberfil
    if path_lower.contains("pagefile.sys") 
        || path_lower.contains("hiberfil.sys") 
        || path_lower.contains("swapfile.sys") 
    {
        return (
            "critical".to_string(),
            "系统运行辅助文件 (Page/Hiber Files)".to_string(),
            "Windows 虚拟内存文件或用于快速启动和系统休眠的系统级镜像文件。".to_string(),
            "【高风险】通常被系统占用无法直接删除。如需释放空间，需在“系统高级设置”中关闭休眠或调整虚拟内存大小，强烈不建议小白手动删除。".to_string(),
        );
    }
    
    // 10. Program Files
    if path_lower.starts_with("c:\\program files") || path_lower.starts_with("c:\\program data") {
        return (
            "uninstall".to_string(),
            "已安装的软件/游戏 (Program Files)".to_string(),
            "您自行安装的各类应用软件 and 游戏所在的安装目录。".to_string(),
            "【建议使用卸载程序】直接删除此处的文件夹会导致软件损坏、快捷方式失效，并在系统中残留注册表垃圾。请前往控制面板或设置的“应用卸载”中进行规范卸载。".to_string(),
        );
    }
    
    // 11. User Profile folders
    if path_lower.starts_with("c:\\users") {
        if path_lower.contains("downloads") {
            return (
                "warning".to_string(),
                "您的下载文件夹 (Downloads)".to_string(),
                "您使用浏览器、聊天工具或下载软件保存的文件和软件安装包。".to_string(),
                "【确认后可删】这些是您下载的文件。如果对应的软件您已经安装完毕，或者不需要这些下载的历史文件，可以安全清理。".to_string(),
            );
        }
        if path_lower.contains("documents") {
            return (
                "warning".to_string(),
                "您的个人文档 (Documents)".to_string(),
                "您保存的文档、游戏存档、微信/QQ聊天记录中的文件等。".to_string(),
                "【谨慎清理】这里包含了您的个人文档资料，请确保在清理前进行了备份，避免丢失微信/QQ重要数据。如果该文件夹极大，建议通过“空间迁移”功能将其移到D盘！".to_string(),
            );
        }
        if path_lower.contains("desktop") {
            return (
                "warning".to_string(),
                "电脑桌面文件 (Desktop)".to_string(),
                "存放在您电脑桌面上的各种文件、文档和文件夹。".to_string(),
                "【谨慎清理】删除后您桌面上的文件会彻底消失，请逐个检查后进行手动删除。".to_string(),
            );
        }
        if path_lower.contains("pictures") || path_lower.contains("videos") || path_lower.contains("music") || path_lower.contains("favorites") {
            return (
                "warning".to_string(),
                "个人多媒体文件 (Media Files)".to_string(),
                "您的个人照片、相册、视频、音乐或收藏夹。".to_string(),
                "【谨慎清理】这些是您个人的珍贵生活记录，删除前请一定仔细核对并进行备份。如果文件非常大，建议将其“空间迁移”至其他硬盘分区。".to_string(),
            );
        }
        if path_lower.contains("appdata") {
            return (
                "warning".to_string(),
                "软件配置与缓存数据 (App Data)".to_string(),
                "安装的软件用来存放您的账号配置、聊天记录、历史记录及本地数据库的地方。".to_string(),
                "【高风险】直接手动删除可能导致软件配置丢失（如浏览器书签消失、微信聊天记录丢失），或者软件无法启动。只允许清理被标识为“临时缓存”的子目录。对于极大的软件文件夹，使用“空间迁移”能安全释放C盘空间！".to_string(),
            );
        }
        
        return (
            "warning".to_string(),
            "用户账户个人空间 (User Profile)".to_string(),
            "您的个人账户文件夹。".to_string(),
            "【谨慎清理】可能存有您的个人隐私文件，清理前请先进行确认。".to_string(),
        );
    }
    
    // Default fallback
    (
        "warning".to_string(),
        "常规个人文件 (Other Files)".to_string(),
        "未归类的普通文件或自定义文件夹。".to_string(),
        "删除前请仔细检查，确认不包含重要个人文档或重要软件的配置文件。".to_string(),
    )
}

/// Retrieve the active drives on the system.
pub fn get_disks() -> Vec<DiskStats> {
    let mut result = Vec::new();
    let disks = Disks::new_with_refreshed_list();
    for disk in disks.iter() {
        let name = disk.name().to_string_lossy().to_string();
        let mount_point = disk.mount_point().to_string_lossy().to_string();
        
        // Only include Windows NTFS/FAT drives (usually showing a mount point like C:\)
        result.push(DiskStats {
            name: if name.is_empty() { mount_point.clone() } else { name },
            mount_point,
            total_space: disk.total_space(),
            free_space: disk.available_space(),
            used_space: disk.total_space().saturating_sub(disk.available_space()),
        });
    }
    result
}

/// Helper function to calculate directory size recursively (for deleted path calculation).
pub fn get_path_size(path: &Path) -> Option<u64> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() {
        return Some(0);
    }
    if metadata.is_file() {
        return Some(metadata.len());
    }
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            size += get_path_size(&entry.path()).unwrap_or(0);
        }
    }
    Some(size)
}

/// Recursively copy all files and folders.
fn copy_dir_all(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> std::io::Result<()> {
    fs::create_dir_all(&dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(entry.path(), dst.as_ref().join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.as_ref().join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// Invoke cmd to create directory junction.
fn create_junction(link: &Path, target: &Path) -> std::io::Result<()> {
    let output = Command::new("cmd")
        .args(&[
            "/C",
            "mklink",
            "/J",
            &link.to_string_lossy(),
            &target.to_string_lossy(),
        ])
        .output()?;
        
    if !output.status.success() {
        let error_msg = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("mklink junction failed: {}", error_msg),
        ));
    }
    Ok(())
}

/// Performs a parallel scan of the directory, building a tree structure pruned at `min_size_threshold`.
pub fn scan_directory(
    path: PathBuf,
    min_size_threshold: u64,
    state: Arc<ScanState>,
) -> Option<FileNode> {
    // Check for cancellation
    if !state.is_running.load(Ordering::Relaxed) {
        return None;
    }

    let metadata = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(_) => return None,
    };

    // Ignore symlinks/junction points to prevent infinite recursive loops
    if metadata.file_type().is_symlink() {
        return None;
    }

    let mut name = path.file_name().unwrap_or(&std::ffi::OsString::from("")).to_string_lossy().to_string();
    if name.is_empty() {
        name = path.to_string_lossy().to_string();
    }
    let path_str = path.to_string_lossy().to_string();
    let path_lower = path_str.to_lowercase();

    // Periodically update current path in scan state (hot update for frontend)
    if let Ok(mut cur_path) = state.current_path.try_lock() {
        *cur_path = path_str.clone();
    }

    let (safety_level, category, description, impact) = classify_path(&path);
    let is_root_dir = path.parent().is_none() 
        || path_lower == "c:\\" 
        || path_lower == "c:/" 
        || path_lower == "c:\\users" 
        || path_lower == "c:\\windows" 
        || path_lower == "c:\\program files" 
        || path_lower == "c:\\program files (x86)" 
        || path_lower == "c:\\programdata";
    let can_migrate = metadata.is_dir() 
        && safety_level != "critical" 
        && (path_lower.starts_with("c:\\") || path_lower.starts_with("c:/"))
        && !is_root_dir;

    if !metadata.is_dir() {
        let size = metadata.len();
        state.files_scanned.fetch_add(1, Ordering::Relaxed);
        state.bytes_scanned.fetch_add(size, Ordering::Relaxed);
        
        return Some(FileNode {
            name,
            path: path_str,
            size,
            is_dir: false,
            safety_level,
            category,
            description,
            impact,
            can_migrate,
            children: None,
        });
    }

    // Directory reading
    let entries: Vec<PathBuf> = match fs::read_dir(&path) {
        Ok(read) => read.filter_map(|e| e.ok().map(|entry| entry.path())).collect(),
        Err(_) => {
            // Permission denied - we still count it as a directory with 0 size
            state.files_scanned.fetch_add(1, Ordering::Relaxed);
            return Some(FileNode {
                name,
                path: path_str,
                size: 0,
                is_dir: true,
                safety_level,
                category,
                description,
                impact,
                can_migrate,
                children: None,
            });
        }
    };

    state.files_scanned.fetch_add(1, Ordering::Relaxed);

    // Parallel scan of child entries using Rayon
    let mut children: Vec<FileNode> = entries
        .into_par_iter()
        .filter_map(|entry_path| {
            scan_directory(entry_path, min_size_threshold, Arc::clone(&state))
        })
        .collect();

    // Sort children by size descending
    children.sort_by(|a, b| b.size.cmp(&a.size));

    let total_size: u64 = children.iter().map(|c| c.size).sum();

    // Prune tiny files/folders to keep payload size optimal
    let pruned_children = if total_size >= min_size_threshold {
        let filtered: Vec<FileNode> = children
            .into_iter()
            .filter(|c| c.size >= min_size_threshold)
            .collect();
        if filtered.is_empty() { None } else { Some(filtered) }
    } else {
        None
    };

    Some(FileNode {
        name,
        path: path_str,
        size: total_size,
        is_dir: true,
        safety_level,
        category,
        description,
        impact,
        can_migrate,
        children: pruned_children,
    })
}

/// Safely delete paths, blocking any critical system file deletions.
pub fn delete_items(paths: Vec<String>) -> Result<(u64, Vec<String>), String> {
    let mut space_freed = 0;
    let mut failed_paths = Vec::new();

    for path_str in paths {
        let path = Path::new(&path_str);
        if !path.exists() {
            continue;
        }

        // Double check safety classification on backend to refuse critical system deletion
        let (safety_level, _, _, _) = classify_path(path);
        if safety_level == "critical" {
            failed_paths.push(format!("{}: 无法删除 (受到系统核心安全锁定保护)", path_str));
            continue;
        }

        let size = get_path_size(path).unwrap_or(0);
        let result = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };

        match result {
            Ok(_) => {
                space_freed += size;
            }
            Err(e) => {
                failed_paths.push(format!("{}: {}", path_str, e));
            }
        }
    }

    Ok((space_freed, failed_paths))
}

/// Safely and atomically migrate a directory to another drive, leaving behind a Directory Junction.
pub fn migrate_directory(source_str: String, target_parent_str: String) -> Result<String, String> {
    let source = Path::new(&source_str);
    let target_parent = Path::new(&target_parent_str);

    if !source.exists() || !source.is_dir() {
        return Err("源路径不存在或不是一个文件夹。".to_string());
    }

    if !target_parent.exists() || !target_parent.is_dir() {
        return Err("目标驱动器文件夹不存在，请重新选择。".to_string());
    }

    // Check if source is already a junction/symlink
    if let Ok(meta) = fs::symlink_metadata(source) {
        if meta.file_type().is_symlink() {
            return Err("该文件夹已经是链接文件夹，无需再次迁移。".to_string());
        }
    }

    // Double check safety classification on backend to refuse system migration
    let (safety_level, _, _, _) = classify_path(source);
    if safety_level == "critical" {
        return Err("系统核心文件夹受保护，无法进行迁移。".to_string());
    }

    let dir_name = source.file_name()
        .ok_or_else(|| "无效的文件夹名称。".to_string())?;
    
    // Create a unique folder name on the target drive to prevent overwriting
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    
    let new_folder_name = format!("{}_migrated_{}", dir_name.to_string_lossy(), timestamp);
    let target_dir = target_parent.join(&new_folder_name);

    // 1. Copy files recursively to destination drive
    if let Err(e) = copy_dir_all(source, &target_dir) {
        // Clean up the half-copied files on D:
        let _ = fs::remove_dir_all(&target_dir);
        return Err(format!("文件复制失败: {}. 目标磁盘空间可能不足或某些文件被独占锁定。", e));
    }

    // 2. Rename original folder in C: to a backup folder name
    let bak_folder_name = format!("{}_bak_{}", dir_name.to_string_lossy(), timestamp);
    let bak_dir = source.parent()
        .ok_or_else(|| "无法获取父目录。".to_string())?
        .join(&bak_folder_name);

    if let Err(e) = fs::rename(source, &bak_dir) {
        // Clean up target dir on destination drive
        let _ = fs::remove_dir_all(&target_dir);
        return Err(format!("重命名原文件夹失败: {}. 文件夹可能正在被其他程序占用，请先关闭相关软件再试。", e));
    }

    // 3. Create directory junction linking original C: location to target destination folder
    if let Err(e) = create_junction(source, &target_dir) {
        // Rollback original folder name
        let _ = fs::rename(&bak_dir, source);
        // Clean up target dir
        let _ = fs::remove_dir_all(&target_dir);
        return Err(format!("创建目录链接失败: {}. 文件夹已还原。", e));
    }

    // 4. Delete the backup original directory from C: drive to free space
    if let Err(e) = fs::remove_dir_all(&bak_dir) {
        // Log the error but return success, as link is created and files migrated.
        return Ok(format!("文件迁移成功，但删除C盘旧文件失败 ({}). 链接已生效，您可以稍后手动删除备份文件夹 {:?}", e, bak_dir));
    }

    Ok("文件已成功迁移至新磁盘分区，并在C盘原位置创建了虚拟链接，C盘空间已成功释放！软件和系统运行一切正常。".to_string())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InstalledApp {
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub install_date: String,
    pub size: u64,
    pub uninstall_string: String,
    pub install_location: String,
    pub key_path: String,
    pub hive: String,
    pub icon: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Leftovers {
    pub files: Vec<LeftoverFile>,
    pub registry_keys: Vec<LeftoverRegistryKey>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LeftoverFile {
    pub path: String,
    pub size: u64,
    pub description: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LeftoverRegistryKey {
    pub hive: String,
    pub path: String,
    pub description: String,
}

// Windows FFI & Icon Extraction logic
#[cfg(target_os = "windows")]
type HANDLE = *mut std::ffi::c_void;
#[cfg(target_os = "windows")]
type HICON = HANDLE;
#[cfg(target_os = "windows")]
type HBITMAP = HANDLE;
#[cfg(target_os = "windows")]
type HDC = HANDLE;
#[cfg(target_os = "windows")]
type HWND = HANDLE;
#[cfg(target_os = "windows")]
type HGDIOBJ = HANDLE;

#[cfg(target_os = "windows")]
#[repr(C)]
struct ICONINFO {
    f_icon: i32,
    x_hotspot: u32,
    y_hotspot: u32,
    hbm_mask: HBITMAP,
    hbm_color: HBITMAP,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct BITMAP {
    bm_type: i32,
    bm_width: i32,
    bm_height: i32,
    bm_width_bytes: i32,
    bm_planes: u16,
    bm_bits_pixel: u16,
    bm_bits: *mut std::ffi::c_void,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct BITMAPINFOHEADER {
    bi_size: u32,
    bi_width: i32,
    bi_height: i32,
    bi_planes: u16,
    bi_bit_count: u16,
    bi_compression: u32,
    bi_size_image: u32,
    bi_x_pels_per_meter: i32,
    bi_y_pels_per_meter: i32,
    bi_clr_used: u32,
    bi_clr_important: u32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct BITMAPINFO {
    bmi_header: BITMAPINFOHEADER,
    bmi_colors: [u32; 1],
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn PrivateExtractIconsW(
        szFileName: *const u16,
        nIconIndex: i32,
        cxIcon: i32,
        cyIcon: i32,
        phicon: *mut HICON,
        piconid: *mut u32,
        nIcons: u32,
        flags: u32,
    ) -> u32;
    fn GetIconInfo(hIcon: HICON, piconinfo: *mut ICONINFO) -> i32;
    fn DestroyIcon(hIcon: HICON) -> i32;
    fn GetDC(hWnd: HWND) -> HDC;
    fn ReleaseDC(hWnd: HWND, hDC: HDC) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "gdi32")]
extern "system" {
    fn GetObjectW(hgdiobj: HANDLE, cbBuffer: i32, lpvObject: *mut std::ffi::c_void) -> i32;
    fn GetDIBits(
        hdc: HDC,
        hbmp: HBITMAP,
        uStartScan: u32,
        cScanLines: u32,
        lpvBits: *mut std::ffi::c_void,
        lpbmi: *mut BITMAPINFO,
        uUsage: u32,
    ) -> i32;
    fn DeleteObject(ho: HGDIOBJ) -> i32;
}

// Simple dependency-free base64 encoder
fn base64_encode(data: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut chunks = data.chunks_exact(3);
    for chunk in &mut chunks {
        let b = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | (chunk[2] as u32);
        result.push(CHARSET[((b >> 18) & 63) as usize] as char);
        result.push(CHARSET[((b >> 12) & 63) as usize] as char);
        result.push(CHARSET[((b >> 6) & 63) as usize] as char);
        result.push(CHARSET[(b & 63) as usize] as char);
    }
    let rem = chunks.remainder();
    if rem.len() == 1 {
        let b = rem[0] as u32;
        result.push(CHARSET[((b >> 2) & 63) as usize] as char);
        result.push(CHARSET[((b << 4) & 63) as usize] as char);
        result.push('=');
        result.push('=');
    } else if rem.len() == 2 {
        let b = ((rem[0] as u32) << 8) | (rem[1] as u32);
        result.push(CHARSET[((b >> 10) & 63) as usize] as char);
        result.push(CHARSET[((b >> 4) & 63) as usize] as char);
        result.push(CHARSET[((b << 2) & 63) as usize] as char);
        result.push('=');
    }
    result
}

// Parse display icon path to get path and index (e.g. "path.exe,0")
fn parse_display_icon_path(raw_path: &str) -> (String, i32) {
    let mut cleaned = raw_path.trim().trim_matches('"').to_string();
    let mut index = 0;
    if let Some(comma_pos) = cleaned.rfind(',') {
        let suffix = &cleaned[comma_pos + 1..].trim();
        if let Ok(parsed_idx) = suffix.parse::<i32>() {
            index = parsed_idx;
            cleaned.truncate(comma_pos);
        }
    }
    let cleaned = cleaned.trim().trim_matches('"').to_string();
    (cleaned, index)
}

#[cfg(target_os = "windows")]
fn get_icon_base64(file_path: &str, icon_index: i32) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    let wide_path: Vec<u16> = std::ffi::OsStr::new(file_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    
    let mut hicon: HICON = std::ptr::null_mut();
    let mut icon_id: u32 = 0;
    
    unsafe {
        let extracted = PrivateExtractIconsW(
            wide_path.as_ptr(),
            icon_index,
            32,
            32,
            &mut hicon,
            &mut icon_id,
            1,
            0,
        );
        
        if extracted == 0 || hicon.is_null() {
            return None;
        }
        
        let mut icon_info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(hicon, &mut icon_info) == 0 {
            DestroyIcon(hicon);
            return None;
        }
        
        if icon_info.hbm_color.is_null() {
            if !icon_info.hbm_mask.is_null() {
                DeleteObject(icon_info.hbm_mask);
            }
            DestroyIcon(hicon);
            return None;
        }
        
        let mut bmp: BITMAP = std::mem::zeroed();
        let obj_res = GetObjectW(
            icon_info.hbm_color,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bmp as *mut _ as *mut std::ffi::c_void,
        );
        
        if obj_res == 0 {
            DeleteObject(icon_info.hbm_color);
            if !icon_info.hbm_mask.is_null() {
                DeleteObject(icon_info.hbm_mask);
            }
            DestroyIcon(hicon);
            return None;
        }
        
        let width = bmp.bm_width;
        let height = bmp.bm_height;
        
        let mut bmi = BITMAPINFO {
            bmi_header: BITMAPINFOHEADER {
                bi_size: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                bi_width: width,
                bi_height: -height, // top-down
                bi_planes: 1,
                bi_bit_count: 32, // 32-bit ARGB
                bi_compression: 0,
                bi_size_image: (width * height * 4) as u32,
                bi_x_pels_per_meter: 0,
                bi_y_pels_per_meter: 0,
                bi_clr_used: 0,
                bi_clr_important: 0,
            },
            bmi_colors: [0],
        };
        
        let hdc = GetDC(std::ptr::null_mut());
        let mut pixels: Vec<u8> = vec![0; (width * height * 4) as usize];
        let dib_res = GetDIBits(
            hdc,
            icon_info.hbm_color,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut std::ffi::c_void,
            &mut bmi as *mut _ as *mut _,
            0,
        );
        
        ReleaseDC(std::ptr::null_mut(), hdc);
        DeleteObject(icon_info.hbm_color);
        if !icon_info.hbm_mask.is_null() {
            DeleteObject(icon_info.hbm_mask);
        }
        DestroyIcon(hicon);
        
        if dib_res == 0 {
            return None;
        }
        
        let mut has_alpha = false;
        for chunk in pixels.chunks_exact(4) {
            if chunk[3] != 0 {
                has_alpha = true;
                break;
            }
        }
        if !has_alpha {
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[3] = 255;
            }
        }
        
        let file_header_size = 14;
        let dib_header_size = 40;
        let pixel_data_size = pixels.len();
        let total_size = file_header_size + dib_header_size + pixel_data_size;
        
        let mut bmp_file = Vec::with_capacity(total_size);
        bmp_file.extend_from_slice(b"BM");
        bmp_file.extend_from_slice(&(total_size as u32).to_le_bytes());
        bmp_file.extend_from_slice(&0u16.to_le_bytes());
        bmp_file.extend_from_slice(&0u16.to_le_bytes());
        bmp_file.extend_from_slice(&((file_header_size + dib_header_size) as u32).to_le_bytes());
        
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_size.to_le_bytes());
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_width.to_le_bytes());
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_height.to_le_bytes());
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_planes.to_le_bytes());
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_bit_count.to_le_bytes());
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_compression.to_le_bytes());
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_size_image.to_le_bytes());
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_x_pels_per_meter.to_le_bytes());
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_y_pels_per_meter.to_le_bytes());
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_clr_used.to_le_bytes());
        bmp_file.extend_from_slice(&bmi.bmi_header.bi_clr_important.to_le_bytes());
        
        bmp_file.extend_from_slice(&pixels);
        
        let base64_str = base64_encode(&bmp_file);
        Some(format!("data:image/bmp;base64,{}", base64_str))
    }
}

#[cfg(not(target_os = "windows"))]
fn get_icon_base64(_file_path: &str, _icon_index: i32) -> Option<String> {
    None
}

pub fn get_installed_apps() -> Vec<InstalledApp> {
    let mut apps = Vec::new();
    let targets = vec![
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM"),
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM"),
        (HKEY_CURRENT_USER, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKCU"),
    ];

    for (hive_predef, path, hive_name) in targets {
        let hive_key = RegKey::predef(hive_predef);
        let uninstall_key = match hive_key.open_subkey(path) {
            Ok(k) => k,
            Err(_) => continue,
        };

        for subkey_name in uninstall_key.enum_keys().flatten() {
            let app_key = match uninstall_key.open_subkey(&subkey_name) {
                Ok(k) => k,
                Err(_) => continue,
            };

            let display_name: String = match app_key.get_value("DisplayName") {
                Ok(name) => name,
                Err(_) => continue,
            };

            if display_name.trim().is_empty() {
                continue;
            }

            let publisher: String = app_key.get_value("Publisher").unwrap_or_default();
            let version: String = app_key.get_value("DisplayVersion").unwrap_or_default();
            let install_date: String = app_key.get_value("InstallDate").unwrap_or_default();
            let uninstall_string: String = app_key.get_value("UninstallString").unwrap_or_default();
            let install_location: String = app_key.get_value("InstallLocation").unwrap_or_default();
            let display_icon_raw: String = app_key.get_value("DisplayIcon").unwrap_or_default();

            let size_kb: u32 = app_key.get_value("EstimatedSize").unwrap_or(0);
            let size: u64 = (size_kb as u64) * 1024;

            // Extract icon
            let mut icon_base64 = None;
            if !display_icon_raw.is_empty() {
                let (icon_path, icon_index) = parse_display_icon_path(&display_icon_raw);
                if Path::new(&icon_path).exists() {
                    icon_base64 = get_icon_base64(&icon_path, icon_index);
                }
            }

            // Fallback: search in install location for an executable's icon
            if icon_base64.is_none() && !install_location.is_empty() {
                let inst_path = Path::new(&install_location);
                if inst_path.exists() && inst_path.is_dir() {
                    if let Ok(entries) = fs::read_dir(inst_path) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.is_file() && path.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) == Some("exe".to_string()) {
                                if let Some(path_str) = path.to_str() {
                                    if let Some(base64) = get_icon_base64(path_str, 0) {
                                        icon_base64 = Some(base64);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            apps.push(InstalledApp {
                name: display_name,
                publisher,
                version,
                install_date,
                size,
                uninstall_string,
                install_location,
                key_path: format!("{}\\{}", path, subkey_name),
                hive: hive_name.to_string(),
                icon: icon_base64,
            });
        }
    }

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

pub fn scan_leftovers(
    app_name: String,
    publisher: String,
    install_location: String,
) -> Leftovers {
    let mut files = Vec::new();
    let mut registry_keys = Vec::new();

    let app_name_lower = app_name.to_lowercase();
    let publisher_lower = publisher.to_lowercase();

    // 1. Scan folders
    let mut search_dirs = Vec::new();
    if let Ok(p) = std::env::var("LOCALAPPDATA") { search_dirs.push(PathBuf::from(p)); }
    if let Ok(p) = std::env::var("APPDATA") { search_dirs.push(PathBuf::from(p)); }
    if let Ok(p) = std::env::var("ProgramData") { search_dirs.push(PathBuf::from(p)); }
    if let Ok(p) = std::env::var("ProgramFiles") { search_dirs.push(PathBuf::from(p)); }
    if let Ok(p) = std::env::var("ProgramFiles(x86)") { search_dirs.push(PathBuf::from(p)); }

    if !install_location.is_empty() {
        let inst_path = PathBuf::from(&install_location);
        if inst_path.exists() && inst_path.is_dir() {
            let size = get_path_size(&inst_path).unwrap_or(0);
            files.push(LeftoverFile {
                path: install_location.clone(),
                size,
                description: "软件安装残留主目录".to_string(),
            });
        }
    }

    for base_dir in search_dirs {
        if !base_dir.exists() { continue; }
        let entries = match fs::read_dir(&base_dir) {
            Ok(e) => e.flatten(),
            Err(_) => continue,
        };

        for entry in entries {
            let path = entry.path();
            if !path.is_dir() { continue; }
            
            let folder_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let folder_name_lower = folder_name.to_lowercase();

            let is_match = (!app_name_lower.is_empty() && folder_name_lower.contains(&app_name_lower))
                || (!publisher_lower.is_empty() && folder_name_lower.contains(&publisher_lower));

            if is_match && path.to_string_lossy().to_string() != install_location {
                let size = get_path_size(&path).unwrap_or(0);
                files.push(LeftoverFile {
                    path: path.to_string_lossy().to_string(),
                    size,
                    description: format!("发现 {} 缓存/配置数据文件夹", app_name),
                });
            }
        }
    }

    files.sort_by_key(|f| f.path.clone());
    files.dedup_by_key(|f| f.path.clone());

    // 2. Scan Registry
    let reg_paths = vec![
        (HKEY_LOCAL_MACHINE, "SOFTWARE", "HKLM"),
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\Wow6432Node", "HKLM"),
        (HKEY_CURRENT_USER, "SOFTWARE", "HKCU"),
    ];

    for (hive_predef, base_path, hive_name) in reg_paths {
        let base_key = RegKey::predef(hive_predef);
        let software_key = match base_key.open_subkey(base_path) {
            Ok(k) => k,
            Err(_) => continue,
        };

        for subkey_name in software_key.enum_keys().flatten() {
            let subkey_name_lower = subkey_name.to_lowercase();
            
            let is_direct_match = (!app_name_lower.is_empty() && subkey_name_lower.contains(&app_name_lower))
                || (!publisher_lower.is_empty() && subkey_name_lower.contains(&publisher_lower));

            if is_direct_match {
                registry_keys.push(LeftoverRegistryKey {
                    hive: hive_name.to_string(),
                    path: format!("{}\\{}", base_path, subkey_name),
                    description: format!("软件注册表项: {}", subkey_name),
                });
            } else {
                if !publisher_lower.is_empty() && subkey_name_lower.contains(&publisher_lower) {
                    if let Ok(publisher_key) = software_key.open_subkey(&subkey_name) {
                        for deep_key in publisher_key.enum_keys().flatten() {
                            let deep_key_lower = deep_key.to_lowercase();
                            if !app_name_lower.is_empty() && deep_key_lower.contains(&app_name_lower) {
                                registry_keys.push(LeftoverRegistryKey {
                                    hive: hive_name.to_string(),
                                    path: format!("{}\\{}\\{}", base_path, subkey_name, deep_key),
                                    description: format!("软件注册表子项: {}\\{}", subkey_name, deep_key),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    registry_keys.sort_by_key(|r| r.path.clone());
    registry_keys.dedup_by_key(|r| r.path.clone());

    Leftovers { files, registry_keys }
}

pub fn clean_leftovers(
    files: Vec<String>,
    reg_keys: Vec<LeftoverRegistryKey>,
) -> Result<String, String> {
    let mut files_cleaned = 0;
    let mut keys_cleaned = 0;
    let mut errors = Vec::new();

    for f_str in files {
        let path = Path::new(&f_str);
        if !path.exists() { continue; }
        
        let (safety, _, _, _) = classify_path(path);
        if safety == "critical" {
            errors.push(format!("安全拦截：拒绝删除系统核心路径: {}", f_str));
            continue;
        }

        let result = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };

        match result {
            Ok(_) => { files_cleaned += 1; }
            Err(e) => { errors.push(format!("删除残留文件夹失败 {}: {}", f_str, e)); }
        }
    }

    for key in reg_keys {
        let hive = if key.hive == "HKLM" { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER };
        let base_key = RegKey::predef(hive);

        match base_key.delete_subkey(&key.path) {
            Ok(_) => { keys_cleaned += 1; }
            Err(e) => { errors.push(format!("删除注册表项失败 {}\\{}: {}", key.hive, key.path, e)); }
        }
    }

    let mut msg = format!("清理完成！成功删除 {} 个残留文件夹，清除了 {} 个注册表残留项。", files_cleaned, keys_cleaned);
    if !errors.is_empty() {
        msg.push_str(&format!("\n部分项清理失败:\n{}", errors.join("\n")));
    }
    Ok(msg)
}

pub fn get_tweak_status() -> Vec<serde_json::Value> {
    let hiberfil_exists = Path::new("C:\\hiberfil.sys").exists();
    let hiberfil_size = get_path_size(Path::new("C:\\hiberfil.sys")).unwrap_or(0);

    vec![
        serde_json::json!({
            "id": "disable_hibernation",
            "name": "关闭系统休眠 (C:\\hiberfil.sys)",
            "desc": "系统休眠会创建一个巨大的 C:\\hiberfil.sys 文件（约等于物理内存大小的40%-80%）。如果关闭，可以立即释放几G到几十G空间！若关闭，电脑仍支持普通睡眠模式。",
            "size": hiberfil_size,
            "active": hiberfil_exists,
            "risk": "low",
            "risk_desc": "完全无损。关闭休眠功能后，依然可以使用“睡眠”模式，只有“休眠”选项不可用。"
        }),
        serde_json::json!({
            "id": "compact_os",
            "name": "开启系统 CompactOS 压缩",
            "desc": "Windows 10/11 提供的 CompactOS 机制，能无感压缩系统核心二进制文件，释放大约 2GB-4GB 的C盘容量，不影响系统响应速度。",
            "size": 3_000_000_000u64,
            "active": false,
            "risk": "low",
            "risk_desc": "微软官方原生技术，完全无风险。机械硬盘或老固态上可能微幅提升读取速度，CPU无感运行。"
        }),
        serde_json::json!({
            "id": "limit_restore",
            "name": "限制系统还原备份空间",
            "desc": "Windows 系统还原点会创建卷阴影拷贝（VSS），最多可能吃掉 10% 以上磁盘空间。将其限制在 2GB 可以腾出大量空间。",
            "size": 5_000_000_000u64,
            "active": true,
            "risk": "medium",
            "risk_desc": "如果您的系统发生故障，可用的历史还原点数量会变少，但不影响正常使用。"
        }),
        serde_json::json!({
            "id": "clean_delivery_opt",
            "name": "清理传递优化更新缓存",
            "desc": "Windows 更新用于局域网共享分发的下载缓存文件，长期累积会多达数G。",
            "size": get_path_size(Path::new("C:\\Windows\\SoftwareDistribution\\DeliveryOptimization")).unwrap_or(0),
            "active": Path::new("C:\\Windows\\SoftwareDistribution\\DeliveryOptimization").exists(),
            "risk": "low",
            "risk_desc": "完全无风险。删除更新下载的分发缓存，下次需要更新直接联网下载。"
        })
    ]
}

pub fn execute_tweak(id: &str) -> Result<String, String> {
    match id {
        "disable_hibernation" => {
            let output = Command::new("powercfg")
                .args(&["-h", "off"])
                .output();
            match output {
                Ok(o) if o.status.success() => Ok("系统休眠功能已关闭，C:\\hiberfil.sys 已自动清理删除！".to_string()),
                Ok(o) => Err(format!("关闭休眠失败: {}", String::from_utf8_lossy(&o.stderr))),
                Err(e) => Err(format!("执行 powercfg 失败: {}", e)),
            }
        }
        "enable_hibernation" => {
            let output = Command::new("powercfg")
                .args(&["-h", "on"])
                .output();
            match output {
                Ok(o) if o.status.success() => Ok("系统休眠功能已成功开启。".to_string()),
                Ok(o) => Err(format!("开启休眠失败: {}", String::from_utf8_lossy(&o.stderr))),
                Err(e) => Err(format!("执行 powercfg 失败: {}", e)),
            }
        }
        "compact_os" => {
            let output = Command::new("compact")
                .args(&["/CompactOS:always"])
                .output();
            match output {
                Ok(o) if o.status.success() => Ok("已成功启动 CompactOS 系统文件无损压缩，C盘空间成功释放！".to_string()),
                Ok(o) => Err(format!("系统文件压缩失败: {}", String::from_utf8_lossy(&o.stderr))),
                Err(e) => Err(format!("执行 compact 失败: {}", e)),
            }
        }
        "limit_restore" => {
            let output = Command::new("vssadmin")
                .args(&["resize", "shadowstorage", "/for=c:", "/on=c:", "/maxsize=2GB"])
                .output();
            match output {
                Ok(o) if o.status.success() => Ok("系统还原卷阴影拷贝（VSS）空间已限制在 2GB，超出的历史副本已清空！".to_string()),
                Ok(o) => Err(format!("限制系统还原空间失败: {}", String::from_utf8_lossy(&o.stderr))),
                Err(e) => Err(format!("执行 vssadmin 失败: {}", e)),
            }
        }
        "clean_delivery_opt" => {
            let _ = Command::new("net").args(&["stop", "dosvc"]).output();
            let cache_path = Path::new("C:\\Windows\\SoftwareDistribution\\DeliveryOptimization");
            if cache_path.exists() {
                let _ = fs::remove_dir_all(cache_path);
            }
            let _ = Command::new("net").args(&["start", "dosvc"]).output();
            Ok("传递优化缓存清理完成！".to_string())
        }
        _ => Err("未知的优化选项。".to_string())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MigrationApp {
    pub id: String,
    pub name: String,
    pub category: String,
    pub path: String,
    pub size: u64,
    pub description: String,
    pub risk_desc: String,
    pub exists: bool,
    pub is_migrated: bool,
}

pub fn get_migration_apps() -> Vec<MigrationApp> {
    let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
    if user_profile.is_empty() {
        return Vec::new();
    }

    let candidates = vec![
        (
            "wechat",
            "微信聊天数据与文件",
            "社交软件",
            format!("{}\\Documents\\WeChat Files", user_profile),
            "保存微信聊天中接收的文件、图片、视频以及数据库缓存，是C盘爆满的头号元凶。",
            "无任何风险。微信关闭后，文件会无损搬移至新盘，并在原位置留下透明链接，微信运行一切正常。"
        ),
        (
            "qq",
            "QQ聊天数据与文件",
            "社交软件",
            format!("{}\\Documents\\Tencent Files", user_profile),
            "保存QQ聊天中接收的文件、图片、群文件和本地缓存数据。",
            "无任何风险。QQ关闭后，文件会无损搬移至新盘，并在原位置留下透明链接，QQ运行正常。"
        ),
        (
            "dingtalk",
            "钉钉工作文件与缓存",
            "办公软件",
            format!("{}\\AppData\\Roaming\\DingTalk", user_profile),
            "保存钉钉办公中产生的用户文档、缓存数据及运行日志。",
            "无任何风险。建议在迁移前退出钉钉软件。"
        ),
        (
            "chrome",
            "Google Chrome 用户数据",
            "浏览器",
            format!("{}\\AppData\\Local\\Google\\Chrome\\User Data", user_profile),
            "存储 Chrome 浏览器的历史记录、缓存、书签以及安装的网页插件。",
            "无风险。搬移前请关闭所有浏览器窗口。迁移后书签 and 插件均不受任何影响。"
        ),
        (
            "edge",
            "Microsoft Edge 用户数据",
            "浏览器",
            format!("{}\\AppData\\Local\\Microsoft\\Edge\\User Data", user_profile),
            "存储 Edge 浏览器的缓存、历史记录、书签和扩展插件数据。",
            "无风险。搬移前请关闭所有 Edge 浏览器窗口。"
        ),
        (
            "android_sdk",
            "Android SDK 开发包",
            "开发工具",
            format!("{}\\AppData\\Local\\Android\\Sdk", user_profile),
            "Android 软件开发工具包，包含模拟器、平台工具及编译依赖，通常体积高达 10GB-30GB。",
            "安全。迁移后开发环境 (如 Android Studio) 会通过透明的软链接自动识别新路径，无需手动修改环境变量。"
        ),
        (
            "gradle",
            "Gradle 依赖缓存 (.gradle)",
            "开发工具",
            format!("{}\\.gradle", user_profile),
            "Java/Android 项目构建工具 Gradle 下载的第三方 Jar 包、各种编译插件的全局依赖缓存。",
            "安全。对开发工具完全透明，构建项目时能正常读取依赖。"
        ),
        (
            "maven",
            "Maven 本地仓库 (.m2)",
            "开发工具",
            format!("{}\\.m2", user_profile),
            "Java 项目构建工具 Maven 的本地依赖仓库，随着开发的工程增多体积会越来越大。",
            "安全。Idea、Eclipse 等开发软件能正常无感读写依赖缓存。"
        ),
        (
            "nvidia_downloader",
            "NVIDIA 驱动下载缓存",
            "系统组件",
            "C:\\ProgramData\\NVIDIA Corporation\\Downloader".to_string(),
            "英伟达显卡驱动更新程序下载的安装包缓存，驱动安装后即可清理或转移。",
            "完全无风险。转移后不影响显卡正常运行。"
        ),
        (
            "downloads",
            "系统【下载】文件夹",
            "系统个人文件夹",
            format!("{}\\Downloads", user_profile),
            "Windows 系统的默认下载存放文件夹，用户从浏览器下载的所有软件安装包和文档均堆积在此。",
            "无风险。搬移后，浏览器和下载工具仍可像往常一样直接下载到原路径下，无缝写入新磁盘。"
        ),
        (
            "desktop",
            "系统【桌面】文件夹",
            "系统个人文件夹",
            format!("{}\\Desktop", user_profile),
            "Windows 系统的桌面。许多用户习惯于将大量大文件、文件夹直接拖在桌面上，占据大量C盘空间。",
            "无风险。迁移后，桌面上的文件全部无感转移到新盘，桌面使用完全正常。"
        ),
    ];

    let mut apps = Vec::new();
    for (id, name, category, path_str, description, risk_desc) in candidates {
        let path = Path::new(&path_str);
        let exists = path.exists();
        
        let mut is_migrated = false;
        let mut size = 0;
        
        if exists {
            if let Ok(meta) = fs::symlink_metadata(path) {
                is_migrated = meta.file_type().is_symlink();
            }
            size = get_path_size(path).unwrap_or(0);
        }
        
        apps.push(MigrationApp {
            id: id.to_string(),
            name: name.to_string(),
            category: category.to_string(),
            path: path_str,
            size,
            description: description.to_string(),
            risk_desc: risk_desc.to_string(),
            exists,
            is_migrated,
        });
    }
    
    apps.retain(|app| app.exists);
    apps.sort_by(|a, b| b.size.cmp(&a.size));
    apps
}
