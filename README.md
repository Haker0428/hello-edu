# Hello Edu

AI 自适应教学与学生知识画像平台的产品设计、系统架构和交互原型。

项目关注的不是单次考试“得了多少分”，而是持续回答三个问题：

1. 学生为什么丢分？
2. 当前真正掌握了哪些知识与能力？
3. 教师下一步应该安排什么练习或干预？

> 当前仓库处于 **产品设计与交互原型阶段**，包含完整需求、模块设计和可浏览的静态原型，尚不是可部署的生产系统。

## 核心闭环

```text
课程
  → 知识点
  → 题目与得分点
  → 学生作答
  → 掌握度与置信度
  → 学生画像
  → 个性化练习
  → 再评估与教师干预
```

设计坚持三项原则：

- **可解释优先**：画像结论能够下钻到题目、得分点和历史证据。
- **教师策略优先**：教学范围、难度、题量和个性化比例始终由教师控制。
- **闭环优先**：看板中的异常应直接连接到复习、练习或干预动作，而不是只展示数据。

## 当前内容

### 可交互原型

| 页面 | 说明 |
| --- | --- |
| [教学首页](design/prototype/index.html) | 以异常和待办为中心的 Action Dashboard |
| [班级知识热力图](design/prototype/heatmap.html) | 查看掌握度、置信度和证据链 |
| [学生画像](design/prototype/student.html) | 展示知识、能力与错误模式 |
| [试卷接入](design/prototype/paper.html) | 试卷拆解和知识点标注确认 |
| [成绩导入](design/prototype/score-import.html) | Excel 逐题得分导入流程 |
| [题库管理](design/prototype/bank.html) | 多知识点映射、难度和版本管理 |
| [练习生成](design/prototype/practice.html) | 基于画像和教师策略生成练习 |
| [试卷编辑器](design/prototype/paper-editor.html) | 手动组卷、排版与打印预览 |
| [登录页](design/prototype/login.html) | 教师端登录入口 |

原型覆盖了“数据接入 → 画像诊断 → 生成练习 → 成绩回流”的主要演示路径。

### 设计文档

- [产品需求：AI 自适应教学与学生知识画像平台](doc/AI_自适应教学与学生知识画像平台.md)
- [总体架构与模块详细设计](doc/架构与模块详细设计.md)
- [13 个模块的设计索引](doc/modules/README.md)
- [原型走查与改进清单](doc/原型走查与改进清单.md)
- [参考项目分析](doc/参考项目分析.md)

## 预览原型

原型由静态 HTML、CSS 和 JavaScript 构成，不需要安装依赖。

直接打开：

```text
design/prototype/login.html
```

也可以在仓库根目录启动本地静态服务器：

```bash
python3 -m http.server 4173 --directory design/prototype
```

然后访问：

```text
http://127.0.0.1:4173/login.html
```

推荐按以下顺序体验：

```text
登录
  → 试卷接入
  → 成绩导入
  → 教学首页
  → 班级知识热力图
  → 学生画像
  → 练习生成
  → 试卷编辑器
  → 题库管理
```

所有页面均使用演示数据，不包含真实学生信息。

## 规划中的系统架构

以下内容是目标架构，不代表仓库中已经包含对应实现。

| 层 | 规划技术 |
| --- | --- |
| 教师端 | React、Vite、TypeScript、Ant Design、ECharts |
| 主服务 | Python、Django、Django REST Framework |
| Agent 网关 | FastAPI、SSE、Provider 原生 Tool Calling |
| 异步任务 | Celery、Redis |
| 数据库 | PostgreSQL，启用行级安全策略（RLS） |
| 文件处理 | PyMuPDF、openpyxl、pandas |
| 导出 | WeasyPrint、python-docx |
| 部署 | Docker Compose，支持校内网私有化部署 |

系统采用模块化单体作为 MVP 起点，以 `StudentAnswerEvent` 作为可回放的事实源。掌握度状态是可重算快照，便于后续替换或升级算法。

## 模块地图

| 类型 | 模块 |
| --- | --- |
| 核心域 | `mastery`、`profile`、`practice`、`dashboard`、`intervention` |
| 支撑域 | `knowledge`、`question`、`ingestion`、`ai` |
| 通用域 | `platform`、`auth`、`file` |

模块边界、接口、数据模型、异常处理和验收标准均记录在 [模块设计文档索引](doc/modules/README.md) 中。

## 仓库结构

```text
.
├── design/
│   └── prototype/               静态交互原型
├── doc/
│   ├── AI_自适应教学与学生知识画像平台.md
│   ├── 架构与模块详细设计.md
│   ├── 原型走查与改进清单.md
│   ├── 参考项目分析.md
│   └── modules/                 13 个领域模块设计
└── README.md
```

## 当前阶段与下一步

当前已完成：

- 产品目标、核心闭环和关键原则定义
- MVP 总体架构及主要 ADR
- 13 个领域模块的详细设计
- 教师端主要页面的静态交互原型
- 原型全链路走查与问题分级

建议下一阶段：

1. 确认“练习生成”和“试卷编辑器”的信息架构。
2. 按 `knowledge → question → mastery → ingestion` 顺序评审核心接口。
3. 建立前后端工程骨架和 PostgreSQL 租户隔离基线。
4. 先实现逐题成绩导入、掌握度更新和证据下钻闭环。
5. 再接入试卷解析、AI 标注和个性化练习生成。

## 数据与合规

这是面向未成年人学习数据的系统设计。正式实现必须至少具备：

- 学校级租户隔离与最小权限访问
- 敏感字段保护、操作审计和数据导出控制
- 云端 LLM 与校内私有模型的可切换能力
- 教师确认机制与 AI 输出的结构化校验
- 演示数据、测试数据和真实学生数据的严格分离
