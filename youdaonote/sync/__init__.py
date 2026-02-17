"""
同步引擎子包

模块划分：
- engine   — SyncManager 主调度
- utils    — SyncDirection / SyncAction / SyncItem / decide_action 等纯工具
- scanner  — scan_cloud / scan_local
- decision — calibrate_metadata / build_item
- moves    — reconcile_moves（移动/重命名检测）
- metadata — SyncMetadata 持久化
- dedup    — auto_dedup / _cloud_score
- git_helper — GitHelper（Git 自动提交）

使用方式：
    from youdaonote.sync.engine import SyncManager
    from youdaonote.sync.utils import SyncDirection, SyncAction
    from youdaonote.sync.metadata import SyncMetadata
"""
