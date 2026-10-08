# 03 · 知识图谱（knowledge）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | 支撑域 / P1 |
| 上游设计 | [架构文档 §4.2 / ADR-3](../../架构与模块详细设计.md) |
| 前端原型 | 热力图列头与章节分组（heatmap.html）、画像分章（student.html） |
| 依赖 | platform |
| 被依赖 | question（映射候选）、ingestion（标注约束）、mastery（前置链）、practice（断点诊断）、dashboard |

## 1. 模块定位与边界

**职责**：四层知识树（课程→章节→知识点→可测量能力点）、三级覆写体系（平台/学校/教师）、前置关系 DAG 及其防环、语义 ID 稳定性保障。

**明确不做**：
- 不做题目（知识点与题目的关系在 question 模块）
- 不做掌握度计算（只提供结构，mastery 消费结构）
- P1 不做校级教研组在线编辑图谱（发布只读 + 教师显示名覆写；在线编辑 P2）

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/curriculums/{id}/knowledge-tree?class_id= | 合并三级覆写后的树（该班教师视角） |
| GET | /api/curriculums/{id}/knowledge-tree | 纯平台标准层（管理用） |
| PATCH | /api/kps/{id}/override | 教师覆写：仅 display_name / enabled（scope=teacher） |
| POST | /api/kps | 教师新增自定义知识点（scope=teacher） |
| POST | /api/kp-edges | 新增前置边（防环校验） |
| DELETE | /api/kp-edges/{id} | 删除边 |
| GET | /api/kps/{id}/prerequisite-chain | 前置链（根在前，含自身） |
| GET | /api/kps?curriculum_id=&layer=&search= | 扁平检索（标注候选注入用） |

**覆写请求约束**：

```json
PATCH /api/kps/1201/override
{ "display_name": "移项（含变号）", "enabled": true }
-- 仅这两字段；改 semantic_code / parent / scope 一律 400
```

## 3. 数据模型

```sql
CREATE TABLE knowledge_point (
  id            BIGSERIAL PRIMARY KEY,
  curriculum_id BIGINT NOT NULL REFERENCES curriculum,
  scope         VARCHAR(8) NOT NULL,     -- platform | school | teacher
  owner_id      BIGINT,                  -- school/teacher 层的归属；platform 层为 NULL
  semantic_code VARCHAR(64) NOT NULL,    -- 稳定语义 ID，覆写合并的 join 键
  display_name  VARCHAR(128) NOT NULL,
  layer         VARCHAR(8) NOT NULL,     -- chapter | topic | kp | ability
  parent_id     BIGINT REFERENCES knowledge_point,   -- 仅 platform 层维护结构
  sort_order    INT DEFAULT 0,
  status        VARCHAR(8) DEFAULT 'active',         -- draft | active | disabled
  meta          JSONB DEFAULT '{}'       -- { objectives:[], common_errors:[], est_minutes }
);
CREATE UNIQUE INDEX uk_kp_semantic ON knowledge_point(curriculum_id, scope, owner_id, semantic_code);

CREATE TABLE kp_edge (                     -- 前置关系 DAG（仅 platform 层维护）
  prerequisite_id BIGINT NOT NULL REFERENCES knowledge_point,
  successor_id    BIGINT NOT NULL REFERENCES knowledge_point,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (prerequisite_id, successor_id),
  CHECK (prerequisite_id <> successor_id)
);

CREATE TABLE learning_objective (
  id BIGSERIAL PRIMARY KEY, kp_id BIGINT NOT NULL REFERENCES knowledge_point,
  description TEXT NOT NULL,              -- 可测量表述："能正确判断移项后的符号变化"
  measurable BOOLEAN DEFAULT true
);
```

**semantic_code 规范**：

```
平台层：{教材码}-{章}.{节}.{序号}   如 PEP7A-03.02.01（人教七上 第3章第2节 知识点1）
自定义：C-{school_id}-{随机8位}     教师自定义点，不与平台层冲突
不变式：发布后 semantic_code 永不修改（教师改显示名不改码，见需求 3.2）
```

## 4. 核心逻辑

### 4.1 三级覆写合并（读时，不物化）

```
resolveTree(curriculum_id, class_id, teacher_id):
  base   = platform 层全部 active 节点（结构树）
  school = school 层覆写（key: semantic_code）→ 应用 display_name / 新增点 / 禁用
  teacher= teacher 层覆写（owner=teacher_id）→ 应用 display_name / enabled / 新增点
  结果 = base 深拷贝上依次打补丁；禁用节点从返回树剔除
  缓存: Redis key kg:{curriculum}:{class}:{teacher}, TTL 10min，覆写写操作失效
```

### 4.2 DAG 防环校验

插入边 `(p → s)` 前检查 **s 沿 successor 方向是否可达 p**：

```sql
WITH RECURSIVE downstream AS (
  SELECT successor_id AS node FROM kp_edge WHERE prerequisite_id = :s
  UNION
  SELECT e.successor_id FROM kp_edge e JOIN downstream d ON e.prerequisite_id = d.node
)
SELECT EXISTS (SELECT 1 FROM downstream WHERE node = :p) AS would_cycle;
-- would_cycle = true → 拒绝（错误码 E_KP_CYCLE）
```

### 4.3 前置链查询

```
prerequisite_chain(kp): DFS 后序遍历（先递归前置，再访问自身），去重，根在前
用途：mastery 断点归因 / practice 前置诊断桶 / 画像前置链展示
```

### 4.4 图谱冷启动流水线（离线，运营工具，非运行时）

```
教材目录(TOC) → LLM 批量拆解（章节→知识点→能力点，附 prerequisite 建议 + 常见错误类型）
  → 人工审核（checklist：① 一学期 kp 总量 80-150 ② 能力点为可测量动词表述
     ③ 前置关系人工抽查 ④ 与教材页码对齐）
  → 发布 platform 层（curriculum.status: draft → active）
```

> P0 期间即启动第一套教材（人教七上数学）的图谱构建，这是 MVP 内容侧的关键路径。LLM 拆解的 prompt 规格见 [12-ai §4.3]((.././12-ai.md/./12-ai.md.md))。

## 5. 关键流程

```
教师 PATCH 覆写显示名 → 失效缓存 → 全系统（热力图列头/标注候选/画像分组）下次读取即新名
教研新增边 → 防环校验 → 写入 → 前置链接口立即包含新依赖
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 教师禁用某知识点 | 展示层过滤；已有 mastery_state **保留不删**，重新启用即恢复 |
| 教师自定义点被标到题目上 | 允许（question_kp_map 正常引用）；仅本校本师可见 |
| 图谱未就绪（新教材） | 标注候选为空 → ingestion 返回 `E_GRAPH_NOT_READY` 并提示运营建图 |
| 平台层重构某知识点（改层级/拆分） | 生成新 semantic_code + 旧码标记 deprecated；存量映射迁移脚本处理 |
| 覆写冲突（教师层与学校层同码不同名） | 就近原则：教师层优先 |

## 7. 验收标准（DoD）

- [ ] 环检测：构造 5 种环（自环/二元/跨分支）全部被拒绝
- [ ] 覆写合并：platform+school+teacher 三层叠加后树结构、名称、禁用正确
- [ ] 前置链：`移项` 返回 `有理数运算→整式运算→合并同类项→去括号→(等式性质)→移项` 且顺序稳定
- [ ] semantic_code 不可变约束的 API 测试（PATCH 其他字段返回 400）
- [ ] 一套真实教材（约 120 节点）冷启动流水线跑通并发布

## 8. 演进预留

- P2：校级在线编辑器（审核流：草稿→教研组确认→发布）；知识点跨教材对齐（升学衔接）
- P3：能力点级细粒度图谱（对接 AI Tutor 的讲解路径）
