export interface DiskStats {
  name: string;
  mount_point: string;
  total_space: number;
  free_space: number;
  used_space: number;
}

export interface FileNode {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  safety_level: 'safe' | 'warning' | 'critical' | 'uninstall';
  category: string;
  description: string;
  impact: string;
  can_migrate: boolean;
  children?: FileNode[];
}

export interface ScanProgress {
  files_scanned: number;
  bytes_scanned: number;
  current_path: string;
  is_running: boolean;
}

export interface InstalledApp {
  name: string;
  publisher: string;
  version: string;
  install_date: string;
  size: number;
  uninstall_string: string;
  install_location: string;
  key_path: string;
  hive: string;
  icon?: string;
}

export interface LeftoverFile {
  path: string;
  size: number;
  description: string;
}

export interface LeftoverRegistryKey {
  hive: string;
  path: string;
  description: string;
}

export interface Leftovers {
  files: LeftoverFile[];
  registry_keys: LeftoverRegistryKey[];
}

export interface TweakItem {
  id: string;
  name: string;
  desc: string;
  size: number;
  active: boolean;
  risk: 'low' | 'medium' | 'high';
  risk_desc: string;
}

export interface MigrationApp {
  id: string;
  name: string;
  category: string;
  path: string;
  size: number;
  description: string;
  risk_desc: string;
  exists: boolean;
  is_migrated: boolean;
}
