# 模块设计文档索引

## 文档地图

```
需求文档（AI_自适应教学与学生知识画像平台.md）
  └─ 架构与模块详细设计.md（总体架构 / ADR / 领域划分）
        ├─ 参考项目分析.md（MathBank / 智卷工坊 全局分析总结）
        └─ modules/（本目录：每模块一个目录，设计文档 + 参考吸收建议）
              └─ ../../design/prototype/（前端交互原型）
```

## 模块清单

> 每个模块目录含 `模块设计文档`；标注 📎 的模块另含对两个参考项目（见下节）的《参考吸收建议.md》。

| 编号 | 模块 | 域 | Phase | 模块设计文档 | 参考吸收 |
| --- | --- | --- | --- | --- | --- |
| 01 | platform · 基础数据与租户 | 通用域 | P1 | [01-platform/](./01-platform/01-platform.md) | — |
| 02 | auth · 认证授权 | 通用域 | P1 | [02-auth/](./02-auth/02-auth.md) | — |
| 03 | knowledge · 知识图谱 | 支撑域 | P1 | [03-knowledge/](./03-knowledge/03-knowledge.md) | 📎 |
| 04 | question · 题库 | 支撑域 | P1 | [04-question/](./04-question/04-question.md) | 📎 |
| 05 | ingestion · 试卷接入 | 支撑域 | P1 | [05-ingestion-paper/](./05-ingestion-paper/05-ingestion-paper.md) | 📎 |
| 06 | ingestion · 成绩导入 | 支撑域 | P1 | [06-ingestion-score/](./06-ingestion-score/06-ingestion-score.md) | — |
| 07 | mastery · 掌握度引擎 | **核心域** | P1 | [07-mastery/](./07-mastery/07-mastery.md) | — |
| 08 | profile · 画像 | **核心域** | P1 | [08-profile/](./08-profile/08-profile.md) | — |
| 09 | practice · 练习生成 | **核心域** | P1 | [09-practice/](./09-practice/09-practice.md) | 📎 |
| 10 | dashboard · 看板与异常 | **核心域** | P1 | [10-dashboard/](./10-dashboard/10-dashboard.md) | — |
| 11 | intervention · 干预闭环 | 核心域 | P2 | [11-intervention/](./11-intervention/11-intervention.md) | — |
| 12 | ai · LLM 能力层 | 支撑域 | P1 | [12-ai/](./12-ai/12-ai.md) | 📎 |
| 13 | file · 文件与导出 | 通用域 | P1 | [13-file/](./13-file/13-file.md) | 📎 |

## 参考项目分析（2026-09-30）

> 完整分析（项目画像 / 对比 / 模块映射矩阵 / 三项高优先修订 / 协议红线）见 **[../参考项目分析.md](../参考项目分析.md)**，以下为摘要。

对两个开源项目的分析结论已落到 6 个模块目录的《参考吸收建议.md》：

| 项目 | 定位 | 协议 | 主要参考价值 |
| --- | --- | --- | --- |
| [JudgePeach/math-question-bank](https://github.com/JudgePeach/math-question-bank)（MathBank） | 本地化高中数学题库 + 组卷排版工作台（FastAPI + SQLite） | **AGPLv3** | PDF/Word 试卷拆解双策略分流与置信度路由、四教材大纲切换映射、A4 仿真排版、Harness 工程化（有界任务/闭环自愈/诊断结构化）、备份与发布工程 |
| [DreZeo/examcraft-ai](https://github.com/DreZeo/examcraft-ai)（智卷工坊） | AI 出卷桌面应用（Tauri + React），AI 生成 + Word 级排版 | MIT | 两阶段受控生成、Schema 校验链 + 自动自我修正、教师版/学生版双视图、分页保真预览、本地优先与密钥管理 |

**全局结论**：

1. **两项目与我们的关系是"单机工具 → 多租户教学闭环"**：它们都止步于"卷"（题库/出卷/排版），没有学生作答回流、掌握度画像与干预闭环——我们的核心域（07/08/09/10/11）无可参考，必须自建；它们最强的恰在我们的支撑域（文档解析、题目 schema、排版导出），值得集中吸收。
2. **跨模块的三项高优先修订**（详见各模块 backlog）：
   - 05：PDF 解析升级为三级分流（原生直提 → 页级路由 VLM → 全图 OCR），L2/L3 从 P2 提前到 P1.5；
   - 09：练习卷增加**教师批改版**（答案 + 评分点上纸面）——打印卷反哺 Rubric 数据质量，直接加速 Error Pattern 激活；
   - 12：LLM 配置从单一 Provider 改为**能力位矩阵**（text / vision），四层校验链（提取 → schema → 领域策略 → 结构化错误回喂自修正）。
3. **协议红线**：MathBank 为 AGPLv3——只吸收设计思想与规格，**代码零复制**（SaaS 网络分发条款风险）；智卷工坊 MIT，可参考实现，借用代码片段保留版权声明。
4. **已出实施文档**（09-practice）：①「试卷编辑器」**先行落地**——手动出题/编辑/排版/三视图打印预览，AI 通道后插 → [试卷编辑器实施方案.md](./09-practice/试卷编辑器实施方案.md)（含可交互原型 [paper-editor.html](../../design/prototype/paper-editor.html)）；②「AI 对话式两阶段组卷」为后续输入通道 → [AI对话组卷实施方案.md](./09-practice/AI对话组卷实施方案.md)。
5. **原型补齐**（04-question，参考 MathBank 题库管理交互）：题库管理页——列表/详情双栏、筛选/草稿箱、知识点权重调整、五维难度、版本历史、作答统计 → 原型 [bank.html](../../design/prototype/bank.html)，设计规格 [04-question §4.5](./04-question/04-question.md)（提前至 P1.5）。

## 模块依赖图

```
platform ──┬─▶ knowledge ──▶ question ──▶ ingestion(05/06)
auth ──────┘       ▲             ▲            │
                   │             │            ▼
                   │        practice ◀── profile ◀── mastery ◀─ 【student_answer_event】
                   │             ▲             ▲
                   └────── dashboard ──────────┘
                                │
                          intervention(P2)
ai ◀─ 被 05/04(P3) 依赖      file ◀─ 被 05/06/09 依赖
```

**依赖纪律**（CI 强制）：核心域只依赖支撑域接口；支撑域不得反向依赖核心域；模块间禁止直查他模块的表，只能走 service 接口。

## 统一文档模板

每份模块设计文档包含：

1. **模块定位与边界**——做什么 / 明确不做什么
2. **对外接口**——API 清单与关键请求/响应结构
3. **数据模型**——DDL 与字段说明
4. **核心逻辑**——算法、状态机、规则的完整定义
5. **关键流程**——时序/流程描述
6. **边界情况与错误处理**
7. **验收标准（DoD）**
8. **演进预留**——向 P2/P3 的接口预留

参考吸收建议统一包含：项目速览 → 值得吸收的点（映射到本模块设计章节）→ 明确不吸收的点 → 设计文档修订项 backlog → 协议与合规提示。

## 评审与开发顺序建议

1. 先评审 **03 knowledge → 04 question**（内容基础，P0 期间可并行启动图谱冷启动）
2. 再评审 **07 mastery**（算法核心，无 UI 依赖，可先行开发+单测）
3. 然后 **05/06 ingestion**（数据入口，决定闭环生死；05 需结合参考吸收建议的解析分流修订）
4. 最后 **08 profile / 09 practice / 10 dashboard**（消费侧，依赖前三者接口稳定）
5. **01/02/13** 常规 CRUD，穿插开发；**12 ai** 随 05 联调；**11 intervention** P2 启动
