/** 网格单元坐标：列/行起点 + 跨度（w=列跨度, h=行跨度） */
export interface GridPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 单个网格项（Widget 卡片）的布局 */
export interface GridItemLayout {
  id: string;
  pos: GridPos;
}

/**
 * 布局快照：持久化到 app_settings 的 JSON（key: `layout:<scope>`）。
 * items 的数组顺序即渲染顺序，pos 为派生信息（当前统一 1×1）。
 */
export interface LayoutSnapshot {
  scope: string;
  columns: number;
  items: GridItemLayout[];
}
