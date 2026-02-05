# Augment-BYOK 全量工具自检（真实场景演练版）

你是负责稳定性验收的工程师。现在要在**当前会话**里做一轮“端到端工具链演练”，目标是回答：这套工具是否可用？失败是否可解释？是否存在“看似成功但没有任何变化”的假阳性？

## 重要约束（必须遵守）

1) **不要在输出里泄露工具入参结构 / 字段名 / JSON 形状**
   - 你可以在脑中根据工具自带的 schema/description 选择正确的最小输入来完成目标。
   - 但在报告里只能写“你做了什么”（自然语言），不能写“你传了哪些字段”。

2) **只在 workspace 内新建一个 RUN_DIR 进行文件/进程演练**
   - RUN_DIR 名称要包含时间戳或随机标识，避免与历史运行冲突。
   - 除非步骤明确要求，不要改动仓库已有文件。

3) **边做边记账**
   - 每调用一个工具，立刻把这一条记录进表格（不要等最后再补）。
   - 如果某工具不存在于当前环境：标记 `SKIPPED (tool not present)`，不要臆测。

## 交付物（必须）

最终输出必须包含：

1) 一张覆盖表（每个工具至少一行）：
   `| 工具 | 场景任务 | 关键输入摘要（不含字段名） | 关键输出摘要 | 状态 | 备注/失败原因 |`

2) “关键发现与建议”（最多 8 条，优先写可操作建议）

3) 若存在 `FAIL`：给出**可复现实验步骤**（自然语言，不含字段名/JSON）

### 状态定义
- `SUCCESS`：调用成功且可观察到预期效果/输出
- `FAIL`：调用失败或效果与预期明显不符
- `SKIPPED`：工具缺失或前置条件缺失导致无法调用
- `OPTIONAL_FAIL`：受宿主策略/环境限制导致不可用（需写清原因，且不影响其它工具验收）

## 演练流程（严格按顺序执行）

### 0) 准备：建立 RUN_DIR
- 创建一个新的 RUN_DIR（在 workspace 内），后续所有临时文件都放在这里。

---

### A) 文件读写链路（`save-file` / `view` / `str-replace-editor` / `remove-files`）

1) 用 `save-file` 在 RUN_DIR 创建一个“探针文本文件”，写入三行可识别内容：
   - 第 2 行必须包含唯一标记：`ABS_PATH_PROBE`

2) 用 `view` 做三件事并记录结果：
   - 列出 RUN_DIR，确认探针文件存在
   - 查看探针文件内容，确认三行都在
   - 在探针文件里搜索第 2 行的标记，确认命中

3) 用 `str-replace-editor` 把 `ABS_PATH_PROBE` 替换为 `ABS_PATH_PROBE_REPLACED`。

4) 再用 `view` 查看探针文件内容，确认替换已生效。

5) 用 `remove-files` 删除探针文件；再用 `view` 列出 RUN_DIR，确认文件确实消失。

---

### B) 进程与“截断引用链路”（`launch-process` / `view-range-untruncated` / `search-untruncated` / `list-processes` / `write-process` / `read-process` / `kill-process` / `read-terminal`）

6) 用 `launch-process` 在 RUN_DIR 生成一个“足够大”的文本文件（建议几千行），并立刻输出它（让输出发生截断）。
   - 大文件中必须包含且只包含一次关键字：`NEEDLE_4242`
   - 记录：输出是否截断、是否出现“引用 ID / reference id”之类的 footer

7) 从截断输出中拿到引用 ID 后：
   - 用 `view-range-untruncated` 读取包含 `NEEDLE_4242` 的附近行，确认能看到该关键字
   - 用 `search-untruncated` 搜索 `NEEDLE_4242`，确认命中并返回上下文

8) 用 `launch-process` 启动一个可交互的 shell（或等价长驻进程），保持运行。

9) 用 `list-processes` 找到该进程并记录它的标识（例如 terminal id）。

10) 用 `write-process` 向该进程写入一条简单命令，让它输出 `BYOK_WRITE_TEST`。

11) 用 `read-process` 读取该进程输出，确认出现了 `BYOK_WRITE_TEST`。

12) 用 `kill-process` 结束该进程；再用 `list-processes` 复核它已退出/被杀掉。

13) 用 `read-terminal` 读取“最近活动终端”的内容并记录（不要求与本次进程一致，只要能稳定返回文本即可）。

---

### C) 诊断与仓库检索（`diagnostics` / `codebase-retrieval`）

14) 在 RUN_DIR 新建一个小的 TS/JS 文件，写入一个明显语法错误。

15) 用 `diagnostics` 对该文件获取诊断结果并记录。
   - 若返回“无诊断”：也记录，但在备注里说明“可能未接入语言服务/诊断源”。（调用本身成功即可算 `SUCCESS`。）

16) 用 `codebase-retrieval` 回答一个实际问题并记录命中摘要与路径：
   - 示例问题：`BYOK-test` 目录/自检临时目录在这个仓库里用于什么？

---

### D) Web 与可视化（`web-fetch` / `web-search` / `open-browser` / `render-mermaid`）

17) 用 `web-fetch` 抓取 `https://example.com`，记录标题或正文片段。

18) 用 `web-search` 搜索一个简单查询（例如与 example.com 相关）。
   - 若出现 404/route missing/未部署：标记 `OPTIONAL_FAIL`，备注“远程 web-search 路由缺失或 remote tools host 未接好”。

19) 用 `open-browser` 尝试打开 `https://example.com`。
   - 若被系统/策略拒绝（无 GUI/禁止打开浏览器）：标记 `OPTIONAL_FAIL`，备注清楚限制来源。

20) 用 `render-mermaid` 画一张“本次演练流程”简图（至少 4 个节点），记录返回是否为可渲染对象。

---

### E) Tasklist 工作流（`view_tasklist` / `add_tasks` / `update_tasks` / `reorganize_tasklist`）

21) 用 `view_tasklist` 获取当前会话任务列表，记录是否能看到 root task。

22) 用 `add_tasks` 新建一个任务：
   - 名称包含 `BYOK Manual Self Test Task`
   - 含一句简短描述
   - 记录：工具返回的变更摘要、以及是否真的在 tasklist 里出现
   - 若出现“无变化/0 changes”或 UI 提示 “No task changes to display”：标记 `FAIL`，并把工具原始文本（或可复述的关键句）写进备注

23) 用 `update_tasks` 把该任务状态推进两次：先变为“进行中”，再变为“完成”。
   - 每次推进后，用 `view_tasklist` 或工具返回内容验证状态确实变化

24) 用 `reorganize_tasklist` 做一次最小重排：把该任务移动到 root 下更靠前的位置。
   - 重排后再 `view_tasklist` 验证顺序变化
   - 若失败提示层级/parent 问题：在备注里说明你提交内容是否混入了标题/说明/空行，并**只重试 1 次**

---

### F) 记忆（`remember`）

25) 用 `remember` 写入一条长期记忆：`BYOK-test 是工具全量测试目录`，记录结果。
   - 若提示 Memories 未启用：标记 `OPTIONAL_FAIL`，备注“需要在设置里打开 Memories”。

---

## 工具清单（必须逐个覆盖一次）

你最终的覆盖表中必须出现下列每个工具（按名称）：
1) `view`
2) `view-range-untruncated`
3) `search-untruncated`
4) `save-file`
5) `str-replace-editor`
6) `remove-files`
7) `launch-process`
8) `list-processes`
9) `read-process`
10) `write-process`
11) `read-terminal`
12) `kill-process`
13) `diagnostics`
14) `codebase-retrieval`
15) `web-search`
16) `web-fetch`
17) `open-browser`
18) `render-mermaid`
19) `view_tasklist`
20) `add_tasks`
21) `update_tasks`
22) `reorganize_tasklist`
23) `remember`

## 现在开始

从“0) 准备：建立 RUN_DIR”开始执行；每次工具调用后立刻更新覆盖表，然后继续下一步。
