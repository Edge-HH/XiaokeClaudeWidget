export type SourceKind = 'claude' | 'deepseek' | 'newapi-token' | 'newapi-account';
export interface SourceConfig {
  id: string;
  name: string;
  kind: SourceKind;
  baseUrl?: string;
  organizationId?: string;
  userId?: string;
  quotaPerUnit?: number;
  currency?: string;
  currencyRate?: number;
}
export interface Preferences { version: 1; activeId: string; sources: SourceConfig[] }
export interface UsageWindow { usedPercent: number; resetsAt: string | null }
export type UsageData =
  | { kind: 'subscription'; fiveHour: UsageWindow | null; week: UsageWindow | null }
  | { kind: 'balance'; remaining: number | null; used: number | null; total: number | null; unit: string; unlimited: boolean; scope: 'account' | 'token' };
export type QueryStatus = 'unconfigured' | 'loading' | 'ready' | 'stale' | 'error';
export interface UsageSnapshot {
  sourceId: string;
  sourceName: string;
  provider?: SourceKind;
  status: QueryStatus;
  observedAt: string | null;
  data: UsageData | null;
  message?: string;
  retryAt?: number;
}
export interface Organization { id: string; name: string }
export interface AssetState { ready: boolean; missing: string[]; provenance: string }
export interface AttachmentState {
  version: string;
  helper: 'starting' | 'running' | 'failed';
  hostDetected: boolean;
  hostVisible: boolean;
  hostMinimized: boolean;
  hostForeground: boolean;
  pageLoaded: boolean;
  bridgeReady: boolean;
  overlayVisible: boolean;
  placementApplied: boolean;
  onTop: boolean;
  keyboardEditing: boolean;
  menuOpen: boolean;
  message: string;
}
export interface DesktopState {
  demo: boolean;
  preferences: Preferences;
  configured: string[];
  snapshot: UsageSnapshot;
  assets: AssetState;
  attachment: AttachmentState;
}
export interface HostGeometry {
  hwnd: string;
  processId: number;
  x: number; y: number; width: number; height: number;
  dpi: number;
  foreground: boolean;
  minimized: boolean;
  visible: boolean;
}
