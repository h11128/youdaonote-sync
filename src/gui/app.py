#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
有道云笔记 GUI — 纯 UI 层

所有业务逻辑（登录、API 调用、搜索、下载）在 gui_controller.py 中。
本模块只负责 tkinter 组件、事件绑定和 UI 更新。
"""

import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import threading
import logging
from typing import Dict

from src.common import DirId

from src.gui.controller import GUIController


class YoudaoNoteGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("有道云笔记管理工具")
        self.root.geometry("1000x700")
        self.root.option_add("*TCombobox*Listbox.selectBackground", "#0078d4")

        self.ctrl = GUIController()

        # Tree 项元数据（item_id → dict）
        self.item_meta: Dict[str, Dict] = {}

        # 下载目录
        self.download_dir = self.ctrl.get_default_download_dir()

        self._create_widgets()
        self.login()

    # ==================== 界面构建 ====================

    def _create_widgets(self):
        main = ttk.Frame(self.root)
        main.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        self._create_toolbar(main)
        self._create_search_bar(main)

        paned = ttk.PanedWindow(main, orient=tk.VERTICAL)
        paned.pack(fill=tk.BOTH, expand=True)

        top = ttk.Frame(paned)
        paned.add(top, weight=3)
        self._create_file_list(top)

        bottom = ttk.Frame(paned)
        paned.add(bottom, weight=1)

        actions = ttk.Frame(bottom)
        actions.pack(fill=tk.X, pady=(4, 0))
        ttk.Button(actions, text="批量下载", command=self.batch_download).pack(side=tk.RIGHT, padx=5)
        ttk.Button(actions, text="选择下载目录", command=self.select_download_dir).pack(side=tk.RIGHT, padx=5)

        self._create_status_area(bottom)

    def _create_toolbar(self, parent):
        frame = ttk.Frame(parent)
        frame.pack(fill=tk.X, pady=(0, 6))
        ttk.Label(frame, text="当前路径:").pack(side=tk.LEFT)
        self.path_var = tk.StringVar(value="/")
        ttk.Label(frame, textvariable=self.path_var, relief=tk.SUNKEN, width=50).pack(side=tk.LEFT, padx=(5, 10))
        ttk.Button(frame, text="刷新", command=self.refresh_current_dir).pack(side=tk.LEFT, padx=5)
        ttk.Button(frame, text="返回上级", command=self.go_back).pack(side=tk.LEFT, padx=5)

    def _create_search_bar(self, parent):
        frame = ttk.Frame(parent)
        frame.pack(fill=tk.X, pady=(0, 8))
        ttk.Label(frame, text="搜索:").pack(side=tk.LEFT)
        self.search_var = tk.StringVar()
        entry = ttk.Entry(frame, textvariable=self.search_var, width=30)
        entry.pack(side=tk.LEFT, padx=6)
        entry.bind("<Return>", lambda _: self.search_items())
        ttk.Button(frame, text="搜索", command=self.search_items).pack(side=tk.LEFT)

    def _create_file_list(self, parent):
        frame = ttk.LabelFrame(parent, text="文件和文件夹")
        frame.pack(fill=tk.BOTH, expand=True, pady=(0, 10))

        cols = ("name", "type", "size", "modified", "id")
        self.tree = ttk.Treeview(frame, columns=cols, show="tree headings", height=15)
        for col, heading, width in [
            ("#0", "名称", 300), ("name", "完整名称", 200), ("type", "类型", 80),
            ("size", "大小", 100), ("modified", "修改时间", 150), ("id", "ID", 100),
        ]:
            self.tree.heading(col, text=heading)
            self.tree.column(col, width=width)

        sy = ttk.Scrollbar(frame, orient=tk.VERTICAL, command=self.tree.yview)
        sx = ttk.Scrollbar(frame, orient=tk.HORIZONTAL, command=self.tree.xview)
        self.tree.configure(yscrollcommand=sy.set, xscrollcommand=sx.set)
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        sy.pack(side=tk.RIGHT, fill=tk.Y)
        sx.pack(side=tk.BOTTOM, fill=tk.X)

        self.tree.bind("<Double-1>", self._on_double_click)
        self.tree.bind("<Button-3>", self._on_right_click)

        self.context_menu = tk.Menu(self.root, tearoff=0)
        self.context_menu.add_command(label="下载", command=self.download_selected)
        self.context_menu.add_command(label="进入文件夹", command=self.enter_folder)
        self.context_menu.add_separator()
        self.context_menu.add_command(label="复制ID", command=self.copy_id)
        self.context_menu.add_command(label="复制路径", command=self.copy_path)

    def _create_status_area(self, parent):
        frame = ttk.LabelFrame(parent, text="状态和进度")
        frame.pack(fill=tk.X, pady=(10, 0))

        self.status_var = tk.StringVar(value="就绪")
        ttk.Label(frame, textvariable=self.status_var).pack(anchor=tk.W, padx=5, pady=2)

        self.progress_var = tk.DoubleVar()
        ttk.Progressbar(frame, variable=self.progress_var, maximum=100, length=400).pack(anchor=tk.W, padx=5, pady=2)

        self.download_dir_var = tk.StringVar(value=f"下载目录: {self.download_dir}")
        ttk.Label(frame, textvariable=self.download_dir_var).pack(anchor=tk.W, padx=5, pady=2)

    # ==================== UI 工具 ====================

    def _run_on_ui(self, func, *args):
        self.root.after(0, func, *args)

    def _set_status(self, message: str):
        def _do():
            try:
                safe = str(message).encode("utf-8", errors="ignore").decode("utf-8")
                self.status_var.set(safe)
            except Exception:
                self.status_var.set("状态更新失败")
        self._run_on_ui(_do)

    @staticmethod
    def _safe_text(text) -> str:
        if not text:
            return ""
        try:
            return str(text).encode("utf-8", errors="ignore").decode("utf-8")
        except Exception:
            return str(text).encode("ascii", errors="ignore").decode("ascii")

    def _insert_tree_row(self, data: dict) -> None:
        """向 tree 插入一行，data 来自 GUIController.format_entry。"""
        try:
            item_id = self.tree.insert(
                "", tk.END,
                text=self._safe_text(data["display_text"]),
                values=(
                    self._safe_text(data["name"]),
                    data["item_type"],
                    data["size_str"],
                    data["time_str"],
                    data["file_id"],
                ),
            )
            self.item_meta[item_id] = {
                "is_dir": data["is_dir"],
                "entry_data": data["entry_data"],
                "full_path": data.get("full_path"),
            }
        except Exception as e:
            logging.error(f"添加树项失败: {e}")

    def _clear_tree(self):
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.item_meta = {}

    # ==================== 事件 / 操作 ====================

    def login(self):
        self._set_status("正在登录...")
        ok, err = self.ctrl.login()
        if not ok:
            messagebox.showerror("登录失败", f"{err}\n\n请运行命令重新登录:\npython -m src login")
            self._set_status("登录失败")
            return
        self._set_status("登录成功")
        self._load_root()

    def _load_root(self):
        dir_id, err = self.ctrl.load_root_directory()
        if err:
            messagebox.showerror("错误", f"加载根目录失败: {err}")
            return
        self.path_var.set(self.ctrl.current_path)
        self._load_dir_async(dir_id)

    def _load_dir_async(self, dir_id: DirId):
        def _work():
            self._set_status("正在加载目录内容...")
            folders, files, err = self.ctrl.load_directory_contents(dir_id)
            if err:
                self._set_status(err)
                self._run_on_ui(lambda: messagebox.showerror("错误", err))
                return

            def _update():
                self._clear_tree()
                for fe in folders:
                    self._insert_tree_row(self.ctrl.format_entry(fe, is_dir=True))
                for fe in files:
                    self._insert_tree_row(self.ctrl.format_entry(fe, is_dir=False))
                self._set_status(f"加载完成 - {len(folders)} 个文件夹, {len(files)} 个文件")
            self._run_on_ui(_update)

        threading.Thread(target=_work, daemon=True).start()

    def enter_folder(self):
        item = self.tree.selection()[0] if self.tree.selection() else None
        if not item:
            return
        meta = self.item_meta.get(item, {})
        if not meta.get("is_dir"):
            messagebox.showwarning("警告", "请选择一个文件夹")
            return
        vals = self.tree.item(item)["values"]
        folder_name, folder_id = vals[0], vals[4]
        self.ctrl.enter_folder(folder_name, folder_id)
        self.path_var.set(self.ctrl.current_path)
        self._load_dir_async(folder_id)

    def go_back(self):
        if self.ctrl.current_path == "/" and not self.ctrl.is_search_mode:
            return
        need_root = self.ctrl.go_back()
        self.search_var.set("")
        if need_root:
            self.path_var.set("/")
            self._load_root()
        else:
            self._load_dir_async(self.ctrl.current_dir_id)

    def refresh_current_dir(self):
        if self.ctrl.is_search_mode:
            self.search_items()
        elif self.ctrl.current_dir_id:
            self._load_dir_async(self.ctrl.current_dir_id)

    def select_download_dir(self):
        d = filedialog.askdirectory(title="选择下载目录")
        if d:
            self.download_dir = d
            self.download_dir_var.set(f"下载目录: {d}")

    def search_items(self):
        kw = self.search_var.get().strip()
        if not kw:
            messagebox.showwarning("警告", "请输入搜索关键词")
            return
        if not self.ctrl.api:
            messagebox.showerror("错误", "请先登录")
            return

        def _work():
            self._set_status(f"正在搜索: {kw}")
            results, err = self.ctrl.search(kw)
            if err:
                self._set_status(err)
                self._run_on_ui(lambda: messagebox.showerror("错误", err))
                return

            def _update():
                self._clear_tree()
                for r in results:
                    self._insert_tree_row(
                        self.ctrl.format_entry(r["entry"], r["is_dir"], r["path"]))
                self._set_status(f"搜索完成 - 找到 {len(results)} 个结果")
            self._run_on_ui(_update)

        threading.Thread(target=_work, daemon=True).start()

    # ---------- 下载 ----------

    def download_selected(self):
        item = self.tree.selection()[0] if self.tree.selection() else None
        if not item:
            messagebox.showwarning("警告", "请选择要下载的项目")
            return
        threading.Thread(target=self._do_download, args=(item,), daemon=True).start()

    def _do_download(self, item):
        try:
            name = self._safe_text(self.tree.item(item)["values"][0])
            self._set_status(f"正在下载: {name}")
            self._run_on_ui(lambda: self.progress_var.set(0))
            self._download_single(item)
            self._run_on_ui(lambda: self.progress_var.set(100))
            self._set_status(f"下载完成: {name}")
            self._run_on_ui(lambda: messagebox.showinfo("成功", f"'{name}' 下载完成!"))
        except Exception as e:
            msg = f"下载失败: {e}"
            self._set_status(msg)
            self._run_on_ui(lambda: messagebox.showerror("错误", msg))

    def _download_single(self, item):
        vals = self.tree.item(item)["values"]
        name = self._safe_text(vals[0])
        fid = vals[4]
        meta = self.item_meta.get(item, {})
        if meta.get("is_dir"):
            self.ctrl.download_folder(fid, name, self.download_dir)
        else:
            self.ctrl.download_file(fid, name, self.download_dir)

    def batch_download(self):
        items = self.tree.selection()
        if not items:
            messagebox.showwarning("警告", "请选择要下载的项目")
            return
        if len(items) == 1:
            self.download_selected()
            return
        if not messagebox.askyesno("确认", f"确定要下载选中的 {len(items)} 个项目吗？"):
            return
        threading.Thread(target=self._batch_download, args=(items,), daemon=True).start()

    def _batch_download(self, items):
        try:
            total = len(items)
            ok = 0
            for i, item in enumerate(items):
                name = self._safe_text(self.tree.item(item)["values"][0])
                self._set_status(f"正在下载 ({i+1}/{total}): {name}")
                pct = (i / total) * 100
                self._run_on_ui(lambda p=pct: self.progress_var.set(p))
                try:
                    self._download_single(item)
                    ok += 1
                except Exception as e:
                    logging.error(f"下载 {name} 失败: {e}")
            self._run_on_ui(lambda: self.progress_var.set(100))
            self._set_status(f"批量下载完成 - 成功: {ok}/{total}")
            self._run_on_ui(lambda: messagebox.showinfo("完成", f"批量下载完成！\n成功: {ok}/{total}"))
        except Exception as e:
            msg = f"批量下载失败: {e}"
            self._set_status(msg)
            self._run_on_ui(lambda: messagebox.showerror("错误", msg))

    # ---------- 剪贴板 ----------

    def copy_id(self):
        item = self.tree.selection()[0] if self.tree.selection() else None
        if not item:
            return
        fid = self.tree.item(item)["values"][4]
        self.root.clipboard_clear()
        self.root.clipboard_append(fid)
        self._set_status(f"已复制ID: {fid}")

    def copy_path(self):
        item = self.tree.selection()[0] if self.tree.selection() else None
        if not item:
            return
        full = self.item_meta.get(item, {}).get("full_path")
        if full:
            path = full
        else:
            name = self.tree.item(item)["values"][0]
            path = f"/{name}" if self.ctrl.current_path == "/" else f"{self.ctrl.current_path}/{name}"
        safe = self._safe_text(path)
        self.root.clipboard_clear()
        self.root.clipboard_append(safe)
        self._set_status(f"已复制路径: {safe}")

    # ---------- 事件绑定 ----------

    def _on_double_click(self, event):
        item = self.tree.selection()[0] if self.tree.selection() else None
        if item and self.item_meta.get(item, {}).get("is_dir"):
            self.enter_folder()

    def _on_right_click(self, event):
        item = self.tree.identify_row(event.y)
        if item:
            self.tree.selection_set(item)
            self.context_menu.post(event.x_root, event.y_root)


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        handlers=[logging.StreamHandler()],
    )
    root = tk.Tk()
    YoudaoNoteGUI(root)
    try:
        root.mainloop()
    except KeyboardInterrupt:
        print("应用被用户中断")
    except Exception as e:
        print(f"应用运行时出错: {e}")


def run_gui():
    """供外部调用的入口函数"""
    main()


if __name__ == "__main__":
    main()
