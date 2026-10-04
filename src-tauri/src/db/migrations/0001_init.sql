-- 0001_init.sql · 基础表（AGENTS §6.2 核心表）
-- migration 约定：文件名 = 版本号，追加式，禁止修改已发布脚本（AGENTS §6.3）。
-- 升级不清数据：所有变更走 migrations。

-- 应用级 KV 设置（主题、侧边栏收起、隐藏模块、窗口等）
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 插件注册表：widget + module 统一登记，含开关 / 排序 / 私有配置
CREATE TABLE IF NOT EXISTS plugins (
    id         TEXT PRIMARY KEY,                       -- 插件唯一标识，如 "weather"
    kind       TEXT NOT NULL DEFAULT 'widget',         -- 'widget' | 'module'
    enabled    INTEGER NOT NULL DEFAULT 1,             -- 0=隐藏 1=显示
    sort       INTEGER NOT NULL DEFAULT 0,             -- 排序权重，越大越靠前
    config     TEXT NOT NULL DEFAULT '{}',             -- 插件私有配置（JSON）
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 布局快照：数据中心网格 / 各模块布局（AGENTS §6.2）
CREATE TABLE IF NOT EXISTS layouts (
    id         TEXT PRIMARY KEY,                       -- 布局实例标识
    scope      TEXT NOT NULL DEFAULT 'data-center',    -- 归属范围
    snapshot   TEXT NOT NULL DEFAULT '{}',             -- 布局快照（JSON）
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
