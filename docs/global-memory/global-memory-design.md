# 全局纯文本记忆

## 定位与目录

记忆是供模型按需检索的历史文本，不提供内容正确性、去重、缺失检测或重建保障。
不使用独立 SQLite、向量、模型摘要抽取或后台抽取队列。

```text
<home>/.tinker/memory/
├── records/<sessionId>.md
└── notes/<UUIDv7>.md
```

home 默认取系统 home，可由 `TINKER_HOME` 覆盖。该目录仅保存需要检索的文本。
会话 SQLite 继续负责 canonical history、恢复与 Recall，与记忆检索独立。

## 会话自然记录

现有 `ObservationTextLog` 的内容格式不变，默认输出路径改为 records 中的文件。
内容包括用户输入、追加指令、助手过程文字、工具观察、最终回答及结束状态。
它是可读文本投影，工具观察中的截断和图片占位保持现状，不等同于完整原始数据。

- 恢复：继续追加同一 sessionId 的文件。
- 克隆：沿用事件重渲染生成新 sessionId 的历史记录，不处理重复。
- 删除 session：保留独立的 memory 文件。
- 历史内容经搜索或 Read 再次进入新记录：不做特殊处理。
- 缺失或中断：不增加检测与重建机制。
- 代码中显式指定 observationLogPath 或关闭 persistence 的调用继续遵守该设置。

## MemoryCreate

沿用 schema：text 必填，trim 后 1–512 UTF-8 字节；summary 可选，trim 后最多
4096 UTF-8 字节。拒绝额外字段。text 用作一级标题（其中换行转为空格），summary
用作正文；时间与 workspace 由程序填入。

```markdown
# 发布时使用自动发布

Created: 2026-09-11T10:30:00.000Z
Workspace: /Users/example/project

App Store 审核通过后自动发布。
```

每次创建独立 UUIDv7 文件，不做去重或模型调用。成功结果包含文件绝对路径。
目录与新建笔记分别使用 0700 和 0600 权限。

## MemorySearch 与 Read

MemorySearch 独立遍历 memory 目录的 Markdown 文件，逐行进行忽略大小写的字面量
子串匹配，不依赖 Grep 或 rg。只搜索普通 .md 文件，不跟随符号链接。

参数为 keywords（必填非空数组，任意关键词命中即可）、context（默认 3）、limit
（默认 20，至少 1）、offset（默认 0）。context/offset 为非负安全整数。关键词去掉
首尾空白，不允许空串或换行；不解释正则，同一行命中多个关键词只计一次。

文件按路径稳定排序。逐行流式读取，选满当前页并补齐上下文、确认下一个命中后即可
停止，不计算全库总数。结果返回 hasMore/nextOffset，文件变动可能影响后续分页。
上下文可以包含下一页的命中，重叠片段合并。长行最多保留 500 个 Unicode 码点，
围绕最早命中的位置截取；无命中的上下文长行截取开头。原文由 Read 按行读取。

内容按文件分组，每个路径仅展示一次；组内保留行号，`>` 标记命中行，`…` 分隔
不连续片段。结果以 memory_search raw kind 保存结构化 files/lines，format 为 text，
观察由这些结构生成。旧向量记忆结果以及前一版 grep 结果仍可解码展示。

MemoryGet、MemoryUpdate、MemoryDelete 不再注册。Search/Create 在 TUI 与 one-shot
中均无需专用配置即可使用。

## 浏览与旧数据

`/memory` 扫描 records 和 notes，展示每份文件的前 4096 字节预览，按记录时间排序。
原 models.json 的 memory 配置接受但忽略，不再要求抽取 profile 或 embedding。

首次使用时，已知的旧 memory.sqlite（含 WAL/SHM）、memory-log.jsonl 与
extracted-memories.log 移到相邻的 `memory-legacy/<UUIDv7>/` 目录保留，不搜索、
不转换。旧 session 目录的 observations.md 在恢复时搬到 records；不会扫描并迁移
全部旧 session。克隆时先在 session 暂存目录重渲染，发布后移动到 records。
