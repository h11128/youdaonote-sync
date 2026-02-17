"""
Git 自动提交辅助模块

同步完成后将变更自动提交到本地 git 仓库。
"""

import logging
import os
import subprocess
from datetime import datetime
from typing import Dict, List, Optional


class GitHelper:
    """封装同步场景下的 git 操作"""

    def __init__(self, repo_dir: str):
        self.repo_dir = os.path.abspath(repo_dir)
        self._is_repo_cached: Optional[bool] = None

    def _run(self, args: List[str], timeout: int = 120) -> subprocess.CompletedProcess:
        """执行 git 命令，统一处理编码"""
        env = os.environ.copy()
        env["GIT_TERMINAL_PROMPT"] = "0"
        return subprocess.run(
            ["git"] + args,
            cwd=self.repo_dir, capture_output=True,
            timeout=timeout, encoding="utf-8", errors="replace",
            env=env,
        )

    def is_git_repo(self) -> bool:
        """检查目录是否是 git 仓库（结果会缓存）"""
        if self._is_repo_cached is not None:
            return self._is_repo_cached
        try:
            self._is_repo_cached = self._run(["rev-parse", "--is-inside-work-tree"], 5).returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            self._is_repo_cached = False
        return self._is_repo_cached

    def has_changes(self, changed_paths: List[str]) -> bool:
        """检查是否有需要提交的变更"""
        return bool(changed_paths) and self.is_git_repo()

    def commit_sync(self, changed_paths: List[str], stats: Dict) -> bool:
        """
        将同步变更自动提交到 git。

        只 add 本次改动的文件，避免全量扫描。

        :param changed_paths: 本次同步实际改动的本地文件绝对路径
        :param stats: 同步统计信息（downloaded, uploaded, conflicts, dedup_deleted）
        :return: 是否成功
        """
        if not self.is_git_repo():
            logging.debug("本地目录不是 git 仓库，跳过 git commit")
            return False

        if not changed_paths:
            return False

        try:
            # 如果有去重删除，需要用 add -u 捕获删除
            has_dedup = stats.get("dedup_deleted", 0) > 0

            # 分批 add 改动文件
            batch_size = 50
            for i in range(0, len(changed_paths), batch_size):
                batch = changed_paths[i:i + batch_size]
                existing = [p for p in batch if os.path.exists(p)]
                if existing:
                    self._run(["add", "--"] + existing)

            # 去重删除的文件需要用 add -u 捕获（限定到 repo 目录，避免暂存无关变更）
            if has_dedup:
                self._run(["add", "-u", "--", "."])

            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            parts = []
            if stats.get("downloaded"):
                parts.append(f"下载 {stats['downloaded']}")
            if stats.get("uploaded"):
                parts.append(f"上传 {stats['uploaded']}")
            if stats.get("conflicts"):
                parts.append(f"冲突 {stats['conflicts']}")
            if stats.get("dedup_deleted"):
                parts.append(f"去重 {stats['dedup_deleted']}")
            summary = ", ".join(parts) if parts else "同步"
            msg = f"sync: {summary} ({now})"

            # 跳过 pre-commit hook：同步内容来自云端，无需 lint
            result = self._run(["commit", "--no-verify", "-m", msg])
            if result.returncode == 0:
                logging.info(f"Git 提交成功: {msg}")
                return True
            else:
                logging.debug(f"Git commit 返回码 {result.returncode}: {result.stderr}")
                return False
        except Exception as e:
            logging.error(f"Git 提交失败: {e}")
            return False
