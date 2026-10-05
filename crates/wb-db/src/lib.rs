//! WorkBench 平台**数据层**（AGENTS §3 规约 7 / §21）。
//!
//! 只回答两个问题：**数据放在哪**（[`storage`]）与**怎么读写**（[`db`] / [`settings`]）。
//!
//! 🔴 本 crate 是依赖链的最下游：它不认识「密钥」「备份」「跨机导入」这些东西，
//! 也因此**不依赖 `wb-runtime`** —— 依赖方向只允许单向（AGENTS §21.2）。
//! 判据一句话：换个完全不相干的业务，这里的代码能原样用吗？

pub mod db;
pub mod settings;
pub mod storage;
