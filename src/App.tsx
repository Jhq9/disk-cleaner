import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { 
  DiskStats, 
  FileNode, 
  ScanProgress, 
  InstalledApp, 
  Leftovers, 
  LeftoverRegistryKey, 
  TweakItem,
  MigrationApp
} from './types';

function App() {
  // Navigation tabs
  const [activeTab, setActiveTab] = useState<'dashboard' | 'quick-clean' | 'migration' | 'explorer' | 'uninstaller' | 'optimizer'>('dashboard');

  // Disk statistics and scan states
  const [disks, setDisks] = useState<DiskStats[]>([]);
  const [selectedDisk, setSelectedDisk] = useState<DiskStats | null>(null);
  const [scanResult, setScanResult] = useState<FileNode | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  // File explorer tree/list toggle and selection state
  const [viewMode, setViewMode] = useState<'tree' | 'large-files'>('tree');
  const [selectedNode, setSelectedNode] = useState<FileNode | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  // Migration states
  const [isMigrateModalOpen, setIsMigrateModalOpen] = useState(false);
  const [folderToMigrate, setFolderToMigrate] = useState<FileNode | MigrationApp | null>(null);
  const [migrateTargetDisk, setMigrateTargetDisk] = useState<DiskStats | null>(null);
  const [migrationStatus, setMigrationStatus] = useState<{ loading: boolean; success?: boolean; error?: string | null }>({ loading: false });
  const [migrationApps, setMigrationApps] = useState<MigrationApp[]>([]);

  // Detailed Quick Clean states
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]); // category names currently expanded
  const [quickCleanSelectedPaths, setQuickCleanSelectedPaths] = useState<string[]>([]); // specific paths selected for cleaning
  const [cleanupStatus, setCleanupStatus] = useState<{ loading: boolean; success?: boolean; message?: string | null }>({ loading: false });

  // App Uninstaller states
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isUninstallingApp, setIsUninstallingApp] = useState<string | null>(null); // app name currently uninstalling
  const [scanningLeftoversFor, setScanningLeftoversFor] = useState<InstalledApp | null>(null);
  const [leftovers, setLeftovers] = useState<Leftovers | null>(null);
  const [selectedLeftoverFiles, setSelectedLeftoverFiles] = useState<string[]>([]);
  const [selectedLeftoverRegs, setSelectedLeftoverRegs] = useState<LeftoverRegistryKey[]>([]);
  const [leftoverCleanLoading, setLeftoverCleanLoading] = useState(false);

  // System Optimizer states
  const [tweaks, setTweaks] = useState<TweakItem[]>([]);
  const [tweakLoading, setTweakLoading] = useState<string | null>(null);

  // Fetch disk list on load
  const fetchDisks = async () => {
    try {
      const diskList: DiskStats[] = await invoke('get_disks');
      setDisks(diskList);
      if (diskList.length > 0) {
        const cDrive = diskList.find(d => d.mount_point.toLowerCase().startsWith('c'));
        setSelectedDisk(cDrive || diskList[0]);
      }
    } catch (err) {
      console.error('Failed to get disk list:', err);
    }
  };

  // Fetch software list
  const fetchInstalledApps = async () => {
    try {
      const apps: InstalledApp[] = await invoke('get_installed_apps');
      setInstalledApps(apps);
    } catch (err) {
      console.error('Failed to get installed apps:', err);
    }
  };

  // Fetch Windows optimization tweaks status
  const fetchTweaks = async () => {
    try {
      const list: TweakItem[] = await invoke('get_tweak_status');
      setTweaks(list);
    } catch (err) {
      console.error('Failed to get tweak status:', err);
    }
  };

  // Fetch migration apps
  const fetchMigrationApps = async () => {
    try {
      const apps: MigrationApp[] = await invoke('get_migration_apps');
      setMigrationApps(apps);
    } catch (err) {
      console.error('Failed to get migration apps:', err);
    }
  };

  useEffect(() => {
    fetchDisks();
    fetchInstalledApps();
    fetchTweaks();
    fetchMigrationApps();
  }, []);

  // Listen to background scanning progress events
  useEffect(() => {
    let unsubscribeProgress: (() => void) | null = null;

    const setupListener = async () => {
      unsubscribeProgress = await listen<ScanProgress>('scan:progress', (event) => {
        setScanProgress(event.payload);
        setIsScanning(event.payload.is_running);
      });
    };

    setupListener();

    return () => {
      if (unsubscribeProgress) {
        unsubscribeProgress();
      }
    };
  }, []);

  // Format bytes helper
  const formatBytes = (bytes: number, decimals = 2) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  };

  // Trigger C:\ disk scan
  const handleStartScan = async () => {
    if (!selectedDisk) return;
    setIsScanning(true);
    setScanResult(null);
    setSelectedNode(null);
    setExpandedPaths(new Set([selectedDisk.mount_point]));
    setQuickCleanSelectedPaths([]);
    setCleanupStatus({ loading: false });

    try {
      const result: FileNode = await invoke('start_disk_scan', { path: selectedDisk.mount_point });
      setScanResult(result);
      setSelectedNode(result);
    } catch (err) {
      console.error('Scan failed:', err);
      alert(`扫描失败: ${err}`);
    } finally {
      setIsScanning(false);
      setScanProgress(null);
      fetchDisks();
      fetchTweaks();
      fetchMigrationApps();
    }
  };

  const handleStopScan = async () => {
    try {
      await invoke('stop_disk_scan');
    } catch (err) {
      console.error('Failed to stop scan:', err);
    }
  };

  // Dynamic accumulator of safe-to-clean files (without duplicates)
  const getSafeCategories = (rootNode: FileNode) => {
    const categories: Record<string, { size: number; paths: string[]; desc: string; impact: string }> = {};

    const walk = (node: FileNode) => {
      if (node.safety_level === 'safe') {
        if (!categories[node.category]) {
          categories[node.category] = {
            size: 0,
            paths: [],
            desc: node.description,
            impact: node.impact,
          };
        }
        categories[node.category].size += node.size;
        categories[node.category].paths.push(node.path);
      } else {
        if (node.children) {
          node.children.forEach(walk);
        }
      }
    };

    walk(rootNode);

    return Object.entries(categories).map(([name, data]) => ({
      name,
      ...data,
    })).sort((a, b) => b.size - a.size);
  };

  // Get migratable candidate folders (FIXED: returns early to avoid double-counting subdirectories)
  const getMigratableFolders = (rootNode: FileNode) => {
    const folders: FileNode[] = [];

    const walk = (node: FileNode) => {
      if (node.can_migrate && node.is_dir && node.size > 20 * 1024 * 1024) {
        folders.push(node);
        return; // Fixed double counting: Stop walking into child folders of a migratable candidate
      }
      if (node.children) {
        node.children.forEach(walk);
      }
    };

    walk(rootNode);
    return folders.sort((a, b) => b.size - a.size);
  };

  // Extracts top 100 large files recursively for the list view
  const getLargestFiles = (rootNode: FileNode, limit = 100): FileNode[] => {
    const files: FileNode[] = [];

    const walk = (node: FileNode) => {
      if (!node.is_dir) {
        files.push(node);
      }
      if (node.children) {
        node.children.forEach(walk);
      }
    };

    walk(rootNode);
    return files.sort((a, b) => b.size - a.size).slice(0, limit);
  };

  // Perform quick clean on paths
  const handleExecuteQuickClean = async () => {
    if (quickCleanSelectedPaths.length === 0) return;
    if (!confirm(`确定要安全清理选中的 ${quickCleanSelectedPaths.length} 个文件/文件夹项目吗？`)) {
      return;
    }

    setCleanupStatus({ loading: true });
    try {
      const [spaceFreed, failed]: [number, string[]] = await invoke('delete_items', { paths: quickCleanSelectedPaths });
      
      const successMessage = `安全清理成功！共释放空间 ${formatBytes(spaceFreed)}。` + 
        (failed.length > 0 ? `\n有 ${failed.length} 个垃圾缓存正在被系统锁定，已自动略过。` : '');
      
      setCleanupStatus({ 
        loading: false, 
        success: true, 
        message: successMessage 
      });

      setQuickCleanSelectedPaths([]);
      handleStartScan();
    } catch (err) {
      setCleanupStatus({ loading: false, success: false, message: `清理遇到错误: ${err}` });
    }
  };

  // Migration logic
  const handleOpenMigration = (node: FileNode | MigrationApp) => {
    setFolderToMigrate(node);
    const target = disks.find(d => d.mount_point.toLowerCase() !== selectedDisk?.mount_point.toLowerCase());
    setMigrateTargetDisk(target || null);
    setMigrationStatus({ loading: false });
    setIsMigrateModalOpen(true);
  };

  const handleConfirmMigration = async () => {
    if (!folderToMigrate || !migrateTargetDisk) return;
    setMigrationStatus({ loading: true, error: null });

    try {
      const response: string = await invoke('migrate_folder', {
        source: folderToMigrate.path,
        targetParent: migrateTargetDisk.mount_point
      });

      setMigrationStatus({ loading: false, success: true });
      alert(response);
      setIsMigrateModalOpen(false);
      setFolderToMigrate(null);
      handleStartScan();
      fetchMigrationApps();
    } catch (err) {
      setMigrationStatus({ loading: false, success: false, error: String(err) });
    }
  };

  // Single file delete in explorer
  const handleDeleteNode = async (node: FileNode) => {
    if (node.safety_level === 'critical') {
      alert('系统核心文件夹受保护，禁止删除！');
      return;
    }
    const levelWarning = node.safety_level === 'uninstall' 
      ? '该文件夹为应用软件，直接删除可能造成残留，建议在“软件管家”中进行清理。'
      : node.safety_level === 'warning'
      ? '该文件夹包含您的个人用户数据，请确保已经备份。'
      : '删除此垃圾文件是完全安全的。';

    if (!confirm(`确定要永久删除此项吗？\n路径: ${node.path}\n大小: ${formatBytes(node.size)}\n\n警告提示: ${levelWarning}`)) {
      return;
    }

    try {
      const [spaceFreed, failed]: [number, string[]] = await invoke('delete_items', { paths: [node.path] });
      if (failed.length > 0) {
        alert(`删除失败: ${failed.join('\n')}`);
      } else {
        alert(`删除完成，释放了 ${formatBytes(spaceFreed)} 的空间。`);
        setSelectedNode(null);
        handleStartScan();
      }
    } catch (err) {
      alert(`删除时出错: ${err}`);
    }
  };

  // Geek-style Software Uninstallation
  const handleUninstallApp = async (app: InstalledApp) => {
    if (!confirm(`确定要启动 ${app.name} 的官方卸载程序吗？`)) {
      return;
    }
    setIsUninstallingApp(app.name);
    try {
      const response: string = await invoke('run_uninstaller', { uninstallString: app.uninstall_string });
      alert(`${response}\n官方卸载完成后，建议立即点击“扫描残留”进行深度垃圾清理。`);
      fetchInstalledApps();
    } catch (err) {
      alert(`启动卸载失败: ${err}`);
    } finally {
      setIsUninstallingApp(null);
    }
  };

  // Scan for software registry and file leftovers
  const handleScanLeftovers = async (app: InstalledApp) => {
    setScanningLeftoversFor(app);
    setLeftovers(null);
    setSelectedLeftoverFiles([]);
    setSelectedLeftoverRegs([]);

    try {
      const result: Leftovers = await invoke('scan_leftovers', {
        appName: app.name,
        publisher: app.publisher,
        installLocation: app.install_location,
      });

      setLeftovers(result);
      // Select all leftovers by default
      setSelectedLeftoverFiles(result.files.map(f => f.path));
      setSelectedLeftoverRegs(result.registry_keys);
    } catch (err) {
      alert(`扫描残留失败: ${err}`);
      setScanningLeftoversFor(null);
    }
  };

  // Execute leftovers cleanup
  const handleCleanLeftovers = async () => {
    if (!scanningLeftoversFor) return;
    setLeftoverCleanLoading(true);

    try {
      const response: string = await invoke('clean_leftovers', {
        files: selectedLeftoverFiles,
        regKeys: selectedLeftoverRegs,
      });

      alert(response);
      setLeftovers(null);
      setScanningLeftoversFor(null);
      fetchInstalledApps();
      handleStartScan(); // Re-scan disk sizes
    } catch (err) {
      alert(`清理残留失败: ${err}`);
    } finally {
      setLeftoverCleanLoading(false);
    }
  };

  // Apply OS tweak adjustment
  const handleApplyTweak = async (tweak: TweakItem) => {
    const action = tweak.active ? 'disable_hibernation' : tweak.id;
    if (tweak.risk === 'medium' && !confirm(`此优化选项有一定风险：\n${tweak.risk_desc}\n确定要应用此项优化吗？`)) {
      return;
    }

    setTweakLoading(tweak.id);
    try {
      const response: string = await invoke('execute_tweak', { id: action });
      alert(response);
      fetchTweaks();
      // Re-scan C盘 to show update sizes
      handleStartScan();
    } catch (err) {
      alert(`执行优化出错: ${err}`);
    } finally {
      setTweakLoading(null);
    }
  };

  // Calculations for dynamic totals
  const safeCategories = scanResult ? getSafeCategories(scanResult) : [];
  const totalSafeSize = safeCategories.reduce((acc, c) => acc + c.size, 0);

  const migratableFolders = scanResult ? getMigratableFolders(scanResult) : [];
  const totalMigratableSize = migratableFolders.reduce((acc, f) => acc + f.size, 0);

  const flatLargeFiles = scanResult ? getLargestFiles(scanResult) : [];

  // Toggle category expansion drawer
  const toggleCategoryDrawer = (catName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (expandedCategories.includes(catName)) {
      setExpandedCategories(expandedCategories.filter(name => name !== catName));
    } else {
      setExpandedCategories([...expandedCategories, catName]);
    }
  };

  // Checkbox states helper for categories
  const getCategoryCheckboxState = (cat: { name: string; paths: string[] }) => {
    const selectedCount = cat.paths.filter(p => quickCleanSelectedPaths.includes(p)).length;
    if (selectedCount === 0) return 'none';
    if (selectedCount === cat.paths.length) return 'all';
    return 'some';
  };

  const handleToggleCategory = (cat: { name: string; paths: string[] }, e: React.MouseEvent) => {
    e.stopPropagation();
    const currentState = getCategoryCheckboxState(cat);
    
    if (currentState === 'all') {
      // Remove all paths
      setQuickCleanSelectedPaths(quickCleanSelectedPaths.filter(p => !cat.paths.includes(p)));
    } else {
      // Add all missing paths
      const otherPaths = quickCleanSelectedPaths.filter(p => !cat.paths.includes(p));
      setQuickCleanSelectedPaths([...otherPaths, ...cat.paths]);
    }
  };

  const handleTogglePath = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (quickCleanSelectedPaths.includes(path)) {
      setQuickCleanSelectedPaths(quickCleanSelectedPaths.filter(p => p !== path));
    } else {
      setQuickCleanSelectedPaths([...quickCleanSelectedPaths, path]);
    }
  };

  // Recursive Tree Node Renderer
  const renderTreeNode = (node: FileNode, depth = 0) => {
    const isExpanded = expandedPaths.has(node.path);
    const hasChildren = node.children && node.children.length > 0;
    const isSelected = selectedNode?.path === node.path;

    const toggleExpand = (e: React.MouseEvent) => {
      e.stopPropagation();
      const newPaths = new Set(expandedPaths);
      if (isExpanded) {
        newPaths.delete(node.path);
      } else {
        newPaths.add(node.path);
      }
      setExpandedPaths(newPaths);
    };

    const maxRootSize = scanResult?.size || 1;
    const percent = Math.max(1, Math.min(100, Math.round((node.size / maxRootSize) * 100)));

    return (
      <div key={node.path} style={{ display: 'flex', flexDirection: 'column' }}>
        <div 
          className={`tree-row ${isSelected ? 'selected' : ''}`} 
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => setSelectedNode(node)}
        >
          <div className="tree-expander" onClick={toggleExpand}>
            {hasChildren ? (isExpanded ? '▼' : '▶') : ' '}
          </div>
          <span className="tree-icon">{node.is_dir ? '📁' : '📄'}</span>
          <span className="tree-name" title={node.name}>{node.name}</span>
          
          <div className="tree-size-bar-container">
            <span className="tree-size-text">{formatBytes(node.size, 1)}</span>
            <div className="tree-bar-outer" title={`${percent}% of scanned disk`}>
              <div className="tree-bar-inner" style={{ width: `${percent}%` }}></div>
            </div>
          </div>
          {getSafetyBadge(node.safety_level)}
        </div>
        
        {isExpanded && hasChildren && node.children?.map(child => renderTreeNode(child, depth + 1))}
      </div>
    );
  };

  const getSafetyBadge = (level: string) => {
    switch (level) {
      case 'safe':
        return <span className="badge badge-safe">完全可清</span>;
      case 'warning':
        return <span className="badge badge-warning">小心备份</span>;
      case 'critical':
        return <span className="badge badge-critical">系统核心 (禁删)</span>;
      case 'uninstall':
        return <span className="badge badge-uninstall">建议卸载</span>;
      default:
        return <span className="badge">{level}</span>;
    }
  };

  // Filter apps list
  const filteredApps = installedApps.filter(app => {
    const q = searchQuery.toLowerCase();
    return app.name.toLowerCase().includes(q) || app.publisher.toLowerCase().includes(q);
  });

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="logo-container">
          <div className="logo-icon">🧼</div>
          <div className="logo-text">极速C盘清理大师</div>
        </div>

        <nav className="nav-menu">
          <div 
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <span className="nav-item-icon">📊</span>
            <span>仪表盘</span>
          </div>
          
          <div 
            className={`nav-item ${activeTab === 'quick-clean' ? 'active' : ''} ${!scanResult ? 'disabled' : ''}`}
            onClick={() => scanResult && setActiveTab('quick-clean')}
            style={{ opacity: scanResult ? 1 : 0.5, cursor: scanResult ? 'pointer' : 'not-allowed' }}
          >
            <span className="nav-item-icon">🧹</span>
            <span>一键安全清理</span>
          </div>

          <div 
            className={`nav-item ${activeTab === 'migration' ? 'active' : ''} ${!scanResult ? 'disabled' : ''}`}
            onClick={() => scanResult && setActiveTab('migration')}
            style={{ opacity: scanResult ? 1 : 0.5, cursor: scanResult ? 'pointer' : 'not-allowed' }}
          >
            <span className="nav-item-icon">🔗</span>
            <span>应用空间迁移</span>
          </div>

          <div 
            className={`nav-item ${activeTab === 'explorer' ? 'active' : ''} ${!scanResult ? 'disabled' : ''}`}
            onClick={() => scanResult && setActiveTab('explorer')}
            style={{ opacity: scanResult ? 1 : 0.5, cursor: scanResult ? 'pointer' : 'not-allowed' }}
          >
            <span className="nav-item-icon">🗂️</span>
            <span>深度文件分析</span>
          </div>

          <div 
            className={`nav-item ${activeTab === 'uninstaller' ? 'active' : ''}`}
            onClick={() => setActiveTab('uninstaller')}
          >
            <span className="nav-item-icon">📦</span>
            <span>软件管家卸载</span>
          </div>

          <div 
            className={`nav-item ${activeTab === 'optimizer' ? 'active' : ''}`}
            onClick={() => setActiveTab('optimizer')}
          >
            <span className="nav-item-icon">⚡</span>
            <span>系统性能优化</span>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div>电脑新手友好安全版 v0.2.0</div>
          <div style={{ marginTop: '4px' }}>Rust + Win32 + Tauri 驱动</div>
        </div>
      </aside>

      {/* Main Workspace */}
      <main className="main-content">
        <header className="content-header">
          <div className="header-title">
            {activeTab === 'dashboard' && '系统状态与扫描'}
            {activeTab === 'quick-clean' && '一键安全清理（展开可查看及选择具体文件）'}
            {activeTab === 'migration' && '大文件空间迁移（搬移至D盘，建立虚拟链接）'}
            {activeTab === 'explorer' && `深度文件清单 (当前视图: ${viewMode === 'tree' ? '树形文件夹' : '前100大文件清单'})`}
            {activeTab === 'uninstaller' && 'Geek 强力卸载软件（彻底扫清注册表与配置残留）'}
            {activeTab === 'optimizer' && '系统瘦身优化（关闭多余核心功能释放空间）'}
          </div>

          <div className="header-actions">
            {disks.length > 0 && activeTab !== 'uninstaller' && activeTab !== 'optimizer' && (
              <select 
                className="select-input" 
                value={selectedDisk?.mount_point || ''}
                onChange={(e) => {
                  const disk = disks.find(d => d.mount_point === e.target.value);
                  if (disk) setSelectedDisk(disk);
                }}
                disabled={isScanning}
              >
                {disks.map(d => (
                  <option key={d.mount_point} value={d.mount_point}>
                    {d.name} ({d.mount_point})
                  </option>
                ))}
              </select>
            )}

            {activeTab !== 'uninstaller' && activeTab !== 'optimizer' && (
              !isScanning ? (
                <button className="btn btn-primary" onClick={handleStartScan}>
                  🔍 开始快速扫描
                </button>
              ) : (
                <button className="btn btn-danger" onClick={handleStopScan}>
                  ⏹ 停止扫描
                </button>
              )
            )}
          </div>
        </header>

        {/* Dynamic Views */}
        <div className="view-container">
          
          {/* Scanning Progress Overlay */}
          {isScanning && (
            <div className="card scanning-overlay">
              <div className="scanning-spinner"></div>
              <h2 style={{ fontFamily: 'var(--font-title)' }}>磁盘正在扫描中...</h2>
              <div style={{ color: 'var(--text-muted)' }}>
                正在运用 Rust 多线程并行爬取文件，大约需要几秒钟。
              </div>
              <div className="disk-info-list" style={{ width: '300px' }}>
                <div className="disk-info-item">
                  <span className="disk-info-label">已扫描文件</span>
                  <span className="disk-info-value">{scanProgress?.files_scanned || 0} 个</span>
                </div>
                <div className="disk-info-item">
                  <span className="disk-info-label">累计文件体积</span>
                  <span className="disk-info-value">{formatBytes(scanProgress?.bytes_scanned || 0)}</span>
                </div>
              </div>
              {scanProgress?.current_path && (
                <div className="scanning-path">
                  当前: {scanProgress.current_path}
                </div>
              )}
            </div>
          )}

          {/* VIEW: Dashboard */}
          {!isScanning && activeTab === 'dashboard' && (
            <div className="dashboard-grid">
              
              {/* Left Column: Disk Circular Chart */}
              <div className="card text-center" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div className="card-title justify-between">
                  <span>磁盘容量统计</span>
                  <span className="badge badge-uninstall">{selectedDisk?.mount_point} 盘</span>
                </div>
                
                {selectedDisk && (
                  <>
                    <div className="progress-radial-container">
                      <svg className="radial-svg">
                        <circle className="radial-bg" cx="100" cy="100" r="80" />
                        <circle 
                          className="radial-fill radial-fill-cyan" 
                          cx="100" 
                          cy="100" 
                          r="80" 
                          strokeDasharray={2 * Math.PI * 80}
                          strokeDashoffset={2 * Math.PI * 80 * (1 - selectedDisk.used_space / selectedDisk.total_space)}
                        />
                      </svg>
                      <div className="radial-text-container">
                        <span className="radial-percent">
                          {Math.round((selectedDisk.used_space / selectedDisk.total_space) * 100)}%
                        </span>
                        <span className="radial-label">已使用</span>
                      </div>
                    </div>

                    <div className="disk-info-list w-full">
                      <div className="disk-info-item">
                        <span className="disk-info-label">总容量</span>
                        <span className="disk-info-value">{formatBytes(selectedDisk.total_space)}</span>
                      </div>
                      <div className="disk-info-item">
                        <span className="disk-info-label">已用空间</span>
                        <span className="disk-info-value">{formatBytes(selectedDisk.used_space)}</span>
                      </div>
                      <div className="disk-info-item">
                        <span className="disk-info-label">可用空间</span>
                        <span className="disk-info-value" style={{ color: 'var(--color-safe)' }}>
                          {formatBytes(selectedDisk.free_space)}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Right Column: Scan summary / Action recommendations */}
              <div className="flex flex-col gap-16">
                {!scanResult ? (
                  <div className="card h-full flex flex-col justify-center align-center empty-state">
                    <div className="empty-icon">📊</div>
                    <div className="empty-title">等待扫描分析</div>
                    <div className="empty-subtitle">
                      点击右上角的 <b>开始快速扫描</b> 按钮，系统会分析您的磁盘，标识出垃圾目录与可无损迁移的软件文件夹。
                    </div>
                  </div>
                ) : (
                  <div className="card h-full flex flex-col gap-16">
                    <div className="card-title">扫描分析报告</div>
                    
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                      <div className="disk-info-item flex-col align-center text-center" style={{ padding: '16px' }}>
                        <span className="disk-info-label" style={{ marginBottom: '6px' }}>可一键安全清理</span>
                        <span className="disk-info-value" style={{ color: 'var(--color-safe)', fontSize: '1.6rem', fontFamily: 'var(--font-title)' }}>
                          {formatBytes(totalSafeSize)}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>不影响任何系统开机稳定性</span>
                      </div>

                      <div className="disk-info-item flex-col align-center text-center" style={{ padding: '16px' }}>
                        <span className="disk-info-label" style={{ marginBottom: '6px' }}>可无损空间迁移</span>
                        <span className="disk-info-value" style={{ color: 'var(--color-cyan)', fontSize: '1.6rem', fontFamily: 'var(--font-title)' }}>
                          {formatBytes(totalMigratableSize)}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>移至其它分区并建立C盘虚拟链接</span>
                      </div>
                    </div>

                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
                      <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.05rem', color: 'var(--text-white)' }}>安全清理建议:</h3>
                      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.45' }}>
                        1. 您的磁盘上有共计 <b style={{ color: 'var(--color-safe)' }}>{formatBytes(totalSafeSize)}</b> 的系统临时日志、缓存、垃圾文件可以一键清空。建议点击 <b>一键安全清理</b> 打开详细清单，展开并选择需要的文件进行清理。
                      </p>
                      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.45' }}>
                        2. 发现微信(WeChat)、个人文档或开发包缓存等占用大户，共计 <b style={{ color: 'var(--color-cyan)' }}>{formatBytes(totalMigratableSize)}</b> 空间。这些文件不能删除，但可以使用 <b>应用空间迁移</b> 功能无损剪切至D盘或E盘！
                      </p>
                    </div>

                    <div className="flex gap-12" style={{ marginTop: '12px' }}>
                      <button className="btn btn-primary" onClick={() => setActiveTab('quick-clean')}>
                        🧹 安全清理
                      </button>
                      <button className="btn btn-secondary" onClick={() => setActiveTab('migration')}>
                        🔗 空间迁移
                      </button>
                      <button className="btn btn-secondary" onClick={() => setActiveTab('explorer')}>
                        🗂️ 深度文件清单
                      </button>
                    </div>
                  </div>
                )}
              </div>

            </div>
          )}

          {/* VIEW: Quick Clean (Detailed File Selection View) */}
          {!isScanning && activeTab === 'quick-clean' && scanResult && (
            <div className="card flex flex-col gap-16">
              <div className="card-title justify-between">
                <span>安全垃圾清理清单</span>
                <span style={{ color: 'var(--color-safe)' }}>预计可释放: {formatBytes(totalSafeSize)}</span>
              </div>
              
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                以下文件由极速引擎识别为【安全清理项目】。您可以<b>点击卡片展开</b>查看具体删除的文件列表，支持单独勾选部分子路径进行精细化清理。
              </p>

              {cleanupStatus.success && cleanupStatus.message && (
                <div className="disk-info-item" style={{ background: 'var(--color-safe-glow)', borderColor: 'var(--color-safe)', padding: '16px', color: 'var(--text-white)' }}>
                  {cleanupStatus.message}
                </div>
              )}

              <div className="category-list">
                {safeCategories.length === 0 ? (
                  <div className="text-center" style={{ padding: '40px', color: 'var(--text-muted)' }}>
                    没有检测到可清理的垃圾文件，系统非常干净！
                  </div>
                ) : (
                  safeCategories.map(cat => {
                    const cbState = getCategoryCheckboxState(cat);
                    const isExpanded = expandedCategories.includes(cat.name);

                    return (
                      <div key={cat.name} style={{ display: 'flex', flexDirection: 'column' }}>
                        <div 
                          className={`category-card ${cbState !== 'none' ? 'selected' : ''}`}
                          onClick={(e) => toggleCategoryDrawer(cat.name, e)}
                          style={{ marginBottom: isExpanded ? '0' : '8px', borderBottomLeftRadius: isExpanded ? '0' : '14px', borderBottomRightRadius: isExpanded ? '0' : '14px' }}
                        >
                          <div 
                            className="category-checkbox" 
                            onClick={(e) => handleToggleCategory(cat, e)}
                            style={{ 
                              background: cbState === 'all' ? 'var(--color-primary)' : 'transparent',
                              borderColor: cbState !== 'none' ? 'var(--color-primary)' : 'rgba(255, 255, 255, 0.2)'
                            }}
                          >
                            {cbState === 'all' && <div className="category-checkbox-check" style={{ display: 'block' }}></div>}
                            {cbState === 'some' && <div style={{ width: '10px', height: '2px', background: 'var(--color-primary)' }}></div>}
                          </div>
                          
                          <div className="category-body">
                            <div className="category-header">
                              <span className="category-title-text">
                                {cat.name} {isExpanded ? '▼' : '▶'}
                              </span>
                              <span className="category-size">{formatBytes(cat.size)}</span>
                            </div>
                            <div className="category-desc">{cat.desc}</div>
                            <div className="category-impact">{cat.impact}</div>
                          </div>
                        </div>

                        {/* Expansion Drawer showing specific file list */}
                        {isExpanded && (
                          <div className="category-drawer" style={{ marginBottom: '8px' }}>
                            {cat.paths.map(path => {
                              const isPathChecked = quickCleanSelectedPaths.includes(path);
                              const pathNodeSize = get_path_size_from_tree(scanResult, path);

                              return (
                                <div 
                                  key={path} 
                                  className="drawer-item"
                                  onClick={(e) => handleTogglePath(path, e)}
                                  style={{ cursor: 'pointer' }}
                                >
                                  <div className="flex align-center gap-8 overflow-hidden">
                                    <div 
                                      className="category-checkbox"
                                      style={{ 
                                        width: '16px', 
                                        height: '16px', 
                                        marginTop: 0,
                                        background: isPathChecked ? 'var(--color-primary)' : 'transparent',
                                        borderColor: isPathChecked ? 'var(--color-primary)' : 'rgba(255, 255, 255, 0.2)'
                                      }}
                                    >
                                      {isPathChecked && <div className="category-checkbox-check" style={{ display: 'block', width: '8px', height: '8px' }}></div>}
                                    </div>
                                    <span className="drawer-path" title={path}>{path}</span>
                                  </div>
                                  <span className="drawer-size">{formatBytes(pathNodeSize)}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <div className="flex gap-12 justify-between align-center" style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--card-border)' }}>
                <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                  已选择 <b style={{ color: 'var(--color-primary)' }}>{quickCleanSelectedPaths.length}</b> 个垃圾目录，共计:{' '}
                  <b style={{ color: 'var(--color-safe)' }}>
                    {formatBytes(
                      quickCleanSelectedPaths.reduce((sum, path) => sum + get_path_size_from_tree(scanResult, path), 0)
                    )}
                  </b>
                </div>

                <div className="flex gap-12">
                  <button 
                    className="btn btn-secondary"
                    onClick={() => {
                      const allPaths = safeCategories.flatMap(c => c.paths);
                      if (quickCleanSelectedPaths.length === allPaths.length) {
                        setQuickCleanSelectedPaths([]);
                      } else {
                        setQuickCleanSelectedPaths(allPaths);
                      }
                    }}
                  >
                    {quickCleanSelectedPaths.length === safeCategories.flatMap(c => c.paths).length ? '全部取消' : '全选所有'}
                  </button>
                  <button 
                    className="btn btn-primary"
                    disabled={quickCleanSelectedPaths.length === 0 || cleanupStatus.loading}
                    onClick={handleExecuteQuickClean}
                  >
                    {cleanupStatus.loading ? '正在清理中...' : '🧹 开始安全清理选中文件'}
                  </button>
                </div>
              </div>

            </div>
          )}

          {/* VIEW: Space Migration */}
          {!isScanning && activeTab === 'migration' && (
            <div className="card flex flex-col gap-16">
              <div className="card-title justify-between">
                <span>应用及个人数据迁移 (搬移至D/E盘，建立透明软链接)</span>
                <span className="badge badge-safe">检测到 {migrationApps.length} 个可迁移大项目</span>
              </div>
              
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                微信聊天文件、浏览器数据、个人桌面/下载文件夹等经常占用C盘几十G空间。
                本工具会将它们安全搬移到D盘或E盘，并在C盘留下透明的虚拟链接。<b>软件和系统仍可在C盘像往常一样读写，文件无损，程序运行完全不受影响。</b>
              </p>

              <div className="category-list" style={{ marginTop: '12px' }}>
                {migrationApps.length === 0 ? (
                  <div className="text-center" style={{ padding: '40px', color: 'var(--text-muted)' }}>
                    未在您的C盘扫描出适合迁移的超大软件缓存或数据文件夹。
                  </div>
                ) : (
                  migrationApps.map(app => {
                    return (
                      <div key={app.path} className="category-card" style={{ cursor: 'default' }}>
                        <div className="category-body">
                          <div className="category-header">
                            <span className="category-title-text" style={{ fontSize: '1.05rem', color: 'var(--text-white)' }}>
                              📁 {app.name} 
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: '10px', fontWeight: 'normal' }}>
                                [{app.category}]
                              </span>
                            </span>
                            <span className="category-size" style={{ color: 'var(--color-cyan)', fontSize: '1.05rem' }}>
                              {formatBytes(app.size)}
                            </span>
                          </div>
                          
                          <div className="detail-val-mono" style={{ margin: '6px 0 10px 0', fontSize: '0.85rem', color: 'var(--text-main)' }}>
                            当前路径: {app.path}
                          </div>
                          
                          <div className="category-desc" style={{ marginBottom: '6px' }}>
                            <span style={{ color: 'var(--text-white)', fontWeight: 600 }}>功能用途: </span>
                            {app.description}
                          </div>
                          
                          <div className="category-desc" style={{ marginBottom: '14px' }}>
                            <span style={{ color: 'var(--color-safe)', fontWeight: 600 }}>无损保障: </span>
                            {app.risk_desc}
                          </div>
                          
                          <div className="flex justify-between align-center" style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                            {app.is_migrated ? (
                              <div className="flex align-center gap-8">
                                <span style={{ color: 'var(--color-safe)', fontWeight: 600, fontSize: '0.9rem' }}>
                                  ✅ 已完成空间迁移，链接正常生效中
                                </span>
                              </div>
                            ) : (
                              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                ⚡ 建议迁移到 D: 或 E: 等大容量存储盘分区。
                              </span>
                            )}
                            
                            <button 
                              className={`btn ${app.is_migrated ? 'btn-secondary' : 'btn-primary'}`}
                              style={{ padding: '8px 18px', fontSize: '0.85rem' }} 
                              disabled={app.is_migrated}
                              onClick={() => handleOpenMigration(app)}
                            >
                              {app.is_migrated ? '已迁移' : '📦 立即无损迁移'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

            </div>
          )}

          {/* VIEW: WizTree File Explorer (Tree Mode + Large Files List Mode) */}
          {!isScanning && activeTab === 'explorer' && scanResult && (
            <div className="explorer-container">
              
              {/* Left Tree/List Panel */}
              <div className="explorer-tree-panel">
                <div className="flex gap-12" style={{ marginBottom: '12px' }}>
                  <button 
                    className={`btn ${viewMode === 'tree' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ padding: '8px 16px', fontSize: '0.85rem' }}
                    onClick={() => setViewMode('tree')}
                  >
                    📁 树形文件夹层级
                  </button>
                  <button 
                    className={`btn ${viewMode === 'large-files' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ padding: '8px 16px', fontSize: '0.85rem' }}
                    onClick={() => setViewMode('large-files')}
                  >
                    📄 C盘超大文件清单 (Top 100)
                  </button>
                </div>

                <div className="tree-viewport">
                  {viewMode === 'tree' ? (
                    renderTreeNode(scanResult)
                  ) : (
                    <div className="flat-list-body">
                      <div className="flat-list-header">
                        <span>文件路径 (双击可在右侧查看安全说明)</span>
                        <span>文件体积</span>
                        <span>操作属性</span>
                      </div>
                      
                      {flatLargeFiles.length === 0 ? (
                        <div className="text-center" style={{ padding: '40px', color: 'var(--text-muted)' }}>
                          未发现可用的大文件。
                        </div>
                      ) : (
                        flatLargeFiles.map(file => {
                          const isSelected = selectedNode?.path === file.path;
                          return (
                            <div 
                              key={file.path}
                              className={`flat-list-item ${isSelected ? 'selected' : ''}`}
                              onClick={() => setSelectedNode(file)}
                            >
                              <div className="flat-list-name" title={file.path}>
                                📄 {file.path}
                              </div>
                              <span className="flat-list-size">
                                {formatBytes(file.size)}
                              </span>
                              <div>
                                {getSafetyBadge(file.safety_level)}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Detail Card */}
              <div className="explorer-detail-panel">
                {selectedNode ? (
                  <div className="card detail-card">
                    <div className="card-title">🔍 选中项分析</div>
                    
                    <div className="detail-row">
                      <div className="detail-label">名称</div>
                      <div className="detail-val" style={{ fontWeight: 600 }}>{selectedNode.name}</div>
                    </div>

                    <div className="detail-row">
                      <div className="detail-label">大小</div>
                      <div className="detail-val" style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                        {formatBytes(selectedNode.size)} ({selectedNode.size.toLocaleString()} 字节)
                      </div>
                    </div>

                    <div className="detail-row">
                      <div className="detail-label">完整路径</div>
                      <div className="detail-val detail-val-mono">{selectedNode.path}</div>
                    </div>

                    <div className="detail-row">
                      <div className="detail-label">安全属性评估</div>
                      <div style={{ marginTop: '4px' }}>
                        {getSafetyBadge(selectedNode.safety_level)}
                      </div>
                    </div>

                    <div className="detail-explain">
                      <div className="detail-explain-section">
                        <div className="detail-explain-title" style={{ color: 'var(--text-white)' }}>
                          ❓ 该文件/文件夹是做什么的？
                        </div>
                        <div className="detail-explain-body">
                          {selectedNode.description}
                        </div>
                      </div>

                      <div className="detail-explain-section" style={{ marginTop: '8px' }}>
                        <div className="detail-explain-title" style={{ 
                          color: selectedNode.safety_level === 'critical' ? 'var(--color-critical)' : 
                                 selectedNode.safety_level === 'warning' ? 'var(--color-warning)' : 
                                 selectedNode.safety_level === 'uninstall' ? 'var(--color-uninstall)' : 'var(--color-safe)'
                        }}>
                          ⚠️ 删除了会有什么后果？
                        </div>
                        <div className="detail-explain-body">
                          {selectedNode.impact}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-8" style={{ marginTop: '8px' }}>
                      {selectedNode.safety_level !== 'critical' && (
                        <button className="btn btn-danger w-full" onClick={() => handleDeleteNode(selectedNode)}>
                          🗑️ 彻底删除此项
                        </button>
                      )}
                      
                      {selectedNode.can_migrate && (
                        <button className="btn btn-primary w-full" onClick={() => handleOpenMigration(selectedNode)}>
                          📦 空间无损迁移
                        </button>
                      )}

                      {selectedNode.safety_level === 'critical' && (
                        <div className="text-center" style={{ fontSize: '0.8rem', color: 'var(--color-critical)', padding: '10px', background: 'var(--color-critical-glow)', borderRadius: '8px', border: '1px solid rgba(244, 63, 94, 0.3)' }}>
                          🔒 系统核心文件夹，安全锁已锁定禁止清理。
                        </div>
                      )}
                    </div>

                  </div>
                ) : (
                  <div className="card text-center" style={{ padding: '40px', color: 'var(--text-muted)' }}>
                    点击左侧树结构或文件清单，在此查看详细的安全属性、说明以及可执行的操作。
                  </div>
                )}
              </div>

            </div>
          )}

          {/* VIEW: App Uninstaller (Geek style) */}
          {!isScanning && activeTab === 'uninstaller' && (
            <div className="card flex flex-col gap-16">
              <div className="card-title justify-between">
                <span>软件管家卸载 (Geek Uninstaller 强力版)</span>
                <span className="badge badge-safe">已检测到 {installedApps.length} 款软件</span>
              </div>

              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                不仅运行官方卸载，还可深度扫描应用残留下的<b>注册表键值、AppData缓存目录</b>，保证卸载干净利落，不占用任何C盘空间。
              </p>

              <div className="flex gap-12 align-center">
                <input 
                  type="text"
                  placeholder="🔍 输入软件名称或开发者进行搜索..."
                  className="search-input"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button className="btn btn-secondary" onClick={fetchInstalledApps} style={{ flexShrink: 0 }}>
                  🔄 刷新列表
                </button>
              </div>

              <div className="app-table-container">
                <table className="app-table">
                  <thead>
                    <tr>
                      <th>软件名称</th>
                      <th>开发者 / 出版商</th>
                      <th>版本</th>
                      <th>大小</th>
                      <th style={{ textAlign: 'center' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredApps.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center" style={{ color: 'var(--text-muted)', padding: '40px' }}>
                          未搜索到匹配的已安装软件。
                        </td>
                      </tr>
                    ) : (
                      filteredApps.map(app => (
                        <tr key={app.key_path}>
                          <td style={{ fontWeight: 600, color: 'var(--text-white)' }}>
                            <div className="flex align-center gap-8">
                              {app.icon ? (
                                <img src={app.icon} className="app-icon" alt="" />
                              ) : (
                                <span style={{ fontSize: '1.2rem', lineHeight: 1 }}>💿</span>
                              )}
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={app.name}>
                                {app.name}
                              </span>
                            </div>
                          </td>
                          <td style={{ color: 'var(--text-muted)' }}>{app.publisher || '未知'}</td>
                          <td style={{ fontFamily: 'var(--font-mono)' }}>{app.version || '1.0'}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                            {app.size > 0 ? formatBytes(app.size) : '未知'}
                          </td>
                          <td>
                            <div className="flex gap-8" style={{ justifyContent: 'center' }}>
                              <button 
                                className="btn btn-secondary"
                                style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                                disabled={isUninstallingApp === app.name}
                                onClick={() => handleUninstallApp(app)}
                              >
                                {isUninstallingApp === app.name ? '卸载中...' : '🗑️ 卸载'}
                              </button>
                              <button 
                                className="btn btn-primary"
                                style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                                onClick={() => handleScanLeftovers(app)}
                              >
                                ✨ 扫描残留
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

            </div>
          )}

          {/* VIEW: System Optimizer */}
          {!isScanning && activeTab === 'optimizer' && (
            <div className="card flex flex-col gap-16">
              <div className="card-title">系统瘦身优化（关闭多余核心功能释放空间）</div>
              
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                以下是 Windows 默认开启、但会占用大量C盘空间的系统级配置。
                您可以根据风险提示关闭或者进行合理限制，来安全释放巨大的磁盘空间。
              </p>

              <div className="category-list" style={{ marginTop: '12px' }}>
                {tweaks.map(tweak => {
                  const isLoading = tweakLoading === tweak.id;
                  
                  return (
                    <div key={tweak.id} className="tweak-card">
                      <div className="tweak-body">
                        <div className="tweak-header">
                          <span className="tweak-title-text">{tweak.name}</span>
                          {tweak.risk === 'low' ? (
                            <span className="badge badge-safe">无风险</span>
                          ) : (
                            <span className="badge badge-warning" title={tweak.risk_desc}>中风险</span>
                          )}
                          {tweak.size > 0 && (
                            <span className="category-size" style={{ color: 'var(--color-safe)' }}>
                              可节省约 {formatBytes(tweak.size)}
                            </span>
                          )}
                        </div>
                        <div className="tweak-desc" style={{ marginBottom: '8px' }}>{tweak.desc}</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-dark)' }}>
                          💡 优化影响说明: {tweak.risk_desc}
                        </div>
                      </div>

                      <div className="flex align-center gap-12">
                        {tweak.id === 'disable_hibernation' ? (
                          <label className="switch">
                            <input 
                              type="checkbox" 
                              checked={!tweak.active}
                              disabled={isLoading}
                              onChange={() => handleApplyTweak(tweak)}
                            />
                            <span className="slider"></span>
                          </label>
                        ) : (
                          <button 
                            className="btn btn-primary"
                            style={{ padding: '8px 16px', fontSize: '0.85rem' }}
                            disabled={isLoading}
                            onClick={() => handleApplyTweak(tweak)}
                          >
                            {isLoading ? '处理中...' : '⚡ 执行优化'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

            </div>
          )}

        </div>
      </main>

      {/* Migration Target Selector Modal */}
      {isMigrateModalOpen && folderToMigrate && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <span>选择迁移的目标驱动器</span>
              <span className="modal-close" onClick={() => setIsMigrateModalOpen(false)}>✕</span>
            </div>

            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              正在将文件夹 <b>{folderToMigrate.name}</b> ({formatBytes(folderToMigrate.size)}) 移出C盘。
              请选择一个有足够容量的磁盘分区：
            </div>

            {migrationStatus.error && (
              <div style={{ color: 'var(--color-critical)', fontSize: '0.85rem', padding: '8px', background: 'var(--color-critical-glow)', borderRadius: '8px', border: '1px solid rgba(244,63,94,0.2)' }}>
                {migrationStatus.error}
              </div>
            )}

            <div className="drive-list">
              {disks
                .filter(d => d.mount_point.toLowerCase() !== selectedDisk?.mount_point.toLowerCase())
                .map(disk => {
                  const isSelected = migrateTargetDisk?.mount_point === disk.mount_point;
                  const isEnoughSpace = disk.free_space > folderToMigrate.size;
                  
                  return (
                    <div 
                      key={disk.mount_point}
                      className={`drive-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => isEnoughSpace && setMigrateTargetDisk(disk)}
                      style={{ 
                        opacity: isEnoughSpace ? 1 : 0.5, 
                        cursor: isEnoughSpace ? 'pointer' : 'not-allowed' 
                      }}
                    >
                      <div className="drive-name">
                        <span>💾</span>
                        <span>{disk.name} ({disk.mount_point})</span>
                      </div>
                      <div className="drive-space text-right">
                        <div>可用: {formatBytes(disk.free_space)}</div>
                        {!isEnoughSpace && (
                          <div style={{ color: 'var(--color-critical)', fontSize: '0.75rem' }}>
                            空间不足
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>

            <div className="flex gap-12" style={{ justifyContent: 'flex-end', marginTop: '10px' }}>
              <button 
                className="btn btn-secondary" 
                onClick={() => setIsMigrateModalOpen(false)}
                disabled={migrationStatus.loading}
              >
                取消
              </button>
              <button 
                className="btn btn-primary"
                disabled={!migrateTargetDisk || migrationStatus.loading}
                onClick={handleConfirmMigration}
              >
                {migrationStatus.loading ? '数据安全无损迁移中...' : '🚚 启动空间迁移'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Uninstaller Leftovers Clean Modal */}
      {scanningLeftoversFor && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ width: '600px', maxHeight: '80vh' }}>
            <div className="modal-header">
              <span>深度扫描残留: {scanningLeftoversFor.name}</span>
              <span className="modal-close" onClick={() => setScanningLeftoversFor(null)}>✕</span>
            </div>

            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              已经深度扫出以下无用垃圾文件夹和注册表键值。请勾选确认后清除：
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto', flex: 1, maxHeight: '50vh', paddingRight: '8px' }}>
              
              {/* Leftover Files */}
              <div>
                <h4 style={{ fontFamily: 'var(--font-title)', color: 'var(--text-white)', marginBottom: '8px', fontSize: '0.95rem' }}>
                  📁 残留文件夹 / 缓存目录
                </h4>
                {leftovers?.files.length === 0 ? (
                  <div style={{ color: 'var(--text-dark)', fontSize: '0.8rem', paddingLeft: '12px' }}>未扫描到残留文件夹</div>
                ) : (
                  leftovers?.files.map(file => {
                    const isChecked = selectedLeftoverFiles.includes(file.path);
                    return (
                      <div 
                        key={file.path} 
                        className="flex align-center gap-8" 
                        style={{ padding: '6px 8px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: '6px', marginBottom: '4px', fontSize: '0.8rem', cursor: 'pointer' }}
                        onClick={() => {
                          if (isChecked) {
                            setSelectedLeftoverFiles(selectedLeftoverFiles.filter(p => p !== file.path));
                          } else {
                            setSelectedLeftoverFiles([...selectedLeftoverFiles, file.path]);
                          }
                        }}
                      >
                        <div 
                          className="category-checkbox" 
                          style={{ 
                            width: '14px', 
                            height: '14px', 
                            marginTop: 0,
                            background: isChecked ? 'var(--color-primary)' : 'transparent',
                            borderColor: isChecked ? 'var(--color-primary)' : 'rgba(255, 255, 255, 0.2)'
                          }}
                        >
                          {isChecked && <div className="category-checkbox-check" style={{ display: 'block', width: '6px', height: '6px' }}></div>}
                        </div>
                        <span className="tree-name" style={{ fontFamily: 'var(--font-mono)', flex: 1 }}>{file.path}</span>
                        <span style={{ color: 'var(--color-safe)', fontFamily: 'var(--font-mono)' }}>{formatBytes(file.size)}</span>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Leftover Registry Keys */}
              <div>
                <h4 style={{ fontFamily: 'var(--font-title)', color: 'var(--text-white)', marginBottom: '8px', fontSize: '0.95rem' }}>
                  🔑 注册表残留项
                </h4>
                {leftovers?.registry_keys.length === 0 ? (
                  <div style={{ color: 'var(--text-dark)', fontSize: '0.8rem', paddingLeft: '12px' }}>未扫描到注册表残留</div>
                ) : (
                  leftovers?.registry_keys.map(reg => {
                    const isChecked = selectedLeftoverRegs.some(r => r.path === reg.path);
                    return (
                      <div 
                        key={reg.path} 
                        className="flex align-center gap-8" 
                        style={{ padding: '6px 8px', background: 'rgba(255, 255, 255, 0.02)', borderRadius: '6px', marginBottom: '4px', fontSize: '0.8rem', cursor: 'pointer' }}
                        onClick={() => {
                          if (isChecked) {
                            setSelectedLeftoverRegs(selectedLeftoverRegs.filter(r => r.path !== reg.path));
                          } else {
                            setSelectedLeftoverRegs([...selectedLeftoverRegs, reg]);
                          }
                        }}
                      >
                        <div 
                          className="category-checkbox" 
                          style={{ 
                            width: '14px', 
                            height: '14px', 
                            marginTop: 0,
                            background: isChecked ? 'var(--color-primary)' : 'transparent',
                            borderColor: isChecked ? 'var(--color-primary)' : 'rgba(255, 255, 255, 0.2)'
                          }}
                        >
                          {isChecked && <div className="category-checkbox-check" style={{ display: 'block', width: '6px', height: '6px' }}></div>}
                        </div>
                        <span className="tree-name" style={{ fontFamily: 'var(--font-mono)', flex: 1 }}>
                          [{reg.hive}] {reg.path}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

            </div>

            <div className="flex gap-12" style={{ justifyContent: 'flex-end', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--card-border)' }}>
              <button className="btn btn-secondary" onClick={() => setScanningLeftoversFor(null)} disabled={leftoverCleanLoading}>
                取消
              </button>
              <button 
                className="btn btn-primary"
                disabled={leftoverCleanLoading || (selectedLeftoverFiles.length === 0 && selectedLeftoverRegs.length === 0)}
                onClick={handleCleanLeftovers}
              >
                {leftoverCleanLoading ? '强力清理残留中...' : '✨ 彻底清除选中残留'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// Helper to look up path size recursively from already-scanned tree (instant lookup on frontend)
function get_path_size_from_tree(node: FileNode | null, path: string): number {
  if (!node) return 0;
  if (node.path === path) return node.size;
  if (node.children) {
    for (const child of node.children) {
      const sz = get_path_size_from_tree(child, path);
      if (sz > 0) return sz;
    }
  }
  return 0;
}

export default App;
