# 04 · 题库（question）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | 支撑域 / P1 |
| 上游设计 | [架构文档 §4.3](../../架构与模块详细设计.md) |
| 前端原型 | 试卷确认队列（paper.html）、练习卷题目卡（practice.html） |
| 依赖 | knowledge（知识点映射） |
| 被依赖 | ingestion（试卷导入建题）、practice（选题）、mastery（分摊权重） |

## 1. 模块定位与边界

**职责**：题目存储与版本化、题目-知识点多对多映射（权重+置信度）、五维难度画像、解答题 Rubric、选题曝光日志。

**明确不做**：
- 不做出题（AI 变式生成在 ai 模块，本模块只接收校验通过的成品）
- 不做选题策略（practice 模块决策，本模块提供检索服务）

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/questions | 建题（含映射与 Rubric） |
| GET | /api/questions/{id} | 详情（含映射/难度/Rubric/版本链） |
| PATCH | /api/questions/{id} | 内容修改 → **生成新版本行**，不原地改 |
| POST | /api/questions/{id}:retire | 停用（检索不可见，历史可查） |
| POST | /api/questions/{id}:restore | 恢复启用（retired → active） |
| PATCH | /api/questions/{id}/kp-maps | 调整知识点映射权重（服务端归一化，教师修正回流评测集） |
| GET | /api/questions:select | **选题服务**（practice 专用，见 §4.2） |
| POST | /api/questions/{id}/rubric | 设置得分点 |
| GET | /api/questions?kp_id=&source=&status= | 管理检索 |

## 3. 数据模型

```sql
CREATE TABLE question (
  id                 BIGSERIAL PRIMARY KEY,
  school_id          BIGINT NOT NULL,          -- 平台标准题为 0（全局共享只读）
  group_id           BIGINT NOT NULL,          -- 版本组：同一题的多个版本同 group
  version            INT NOT NULL DEFAULT 1,
  type               VARCHAR(16) NOT NULL,     -- choice | fill | judge | solve | composite
  stem               TEXT NOT NULL,
  options            JSONB,                    -- 选择题选项
  answer             TEXT,
  analysis           TEXT,                     -- 解析（P3 AI Tutor 用）
  source             VARCHAR(16) NOT NULL,     -- bank | exam_import | ai_variant
  parent_question_id BIGINT,                   -- ai_variant 的母题
  verify_status      VARCHAR(12),              -- ai_variant 专用: pending|passed|failed
  difficulty_profile JSONB NOT NULL,           -- 五维（见 §4.1）
  status             VARCHAR(12) DEFAULT 'active',  -- draft | active | retired
  created_by BIGINT, created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (group_id, version)
);

CREATE TABLE question_kp_map (
  question_id BIGINT NOT NULL REFERENCES question,
  kp_id       BIGINT NOT NULL REFERENCES knowledge_point,
  weight      NUMERIC(4,3) NOT NULL,           -- 同题内 Σweight = 1
  confidence  NUMERIC(3,2) NOT NULL,           -- 标注来源置信度 0~1
  source      VARCHAR(8) NOT NULL,             -- platform | ai | teacher
  PRIMARY KEY (question_id, kp_id)
);

CREATE TABLE scoring_rubric (
  question_id BIGINT NOT NULL REFERENCES question,
  step_no     INT NOT NULL,
  description TEXT NOT NULL,
  score       NUMERIC(4,1) NOT NULL,           -- Σscore = 题目满分
  kp_id       BIGINT REFERENCES knowledge_point,        -- 该步骤考查的点（可空）
  error_hint  VARCHAR(64),                     -- 常见错误提示（error pattern 归类锚点）
  PRIMARY KEY (question_id, step_no)
);

CREATE TABLE question_exposure (               -- 选题去重依据
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  held_until  TIMESTAMPTZ,                     -- soft-hold（预览占位，10 分钟）
  committed   BOOLEAN DEFAULT false,           -- 确认导出后固化
  exposed_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (student_id, question_id, exposed_at)
);
CREATE INDEX idx_exposure_lookup ON question_exposure(student_id, question_id, committed);
```

## 4. 核心逻辑

### 4.1 难度画像（Difficulty Profile）

```json
{
  "knowledge_level": 2,      // 知识层级 1-5（单一能力点 → 跨章综合）
  "computation":     3,      // 计算复杂度 1-5
  "reasoning":       2,      // 推理复杂度 1-5
  "reading_comp":    1,      // 文字理解复杂度 1-5
  "kp_count":        2       // 涉及知识点数（由映射自动同步，禁手填）
}
```

校验规则：五维均为 1-5 整数；`kp_count` == 映射条数（触发器同步）。

### 4.2 选题服务（practice 的底层）

```
GET /api/questions:select
    ?kp_ids=1201,1204           // 目标知识点（含 OR 匹配）
    &difficulty_band=1-2        // 允许的难度区间（按综合分）
    &student_id=101             // 用于曝光排除
    &exclude_days=14            // 曝光回看窗口
    &limit=5
    &prefer_retest=true         // 优先"做错未重测"题

服务端：
  WHERE status=active AND (verify_status IS NULL OR verify_status='passed')
    AND question_kp_map ∩ kp_ids
    AND 综合难度 ∈ band
    AND NOT EXISTS (近 exclude_days 天 committed 曝光, 该 student)
  ORDER BY 曝光久远优先, (prefer_retest: 最近做错且之后无对 → 置顶), 随机扰动
  → 返回题目卡列表（含映射与难度，不含答案字段以外的解析）
```

### 4.3 版本化规则（架构不变量的落点）

```
修改题目内容（stem/answer/options/difficulty/rubric）：
  → 新建行：同 group_id, version+1, status=active；旧行 status=retired
  → student_answer_event.question_id 永远指向作答当时的那一行
效果：3 个月前"做错的题"永远可按当时定义回放与展示
仅改映射（kp weight）不触发版本化（映射有自身置信度与来源追踪）
```

### 4.4 曝光写入时机

```
预览生成（practice 生成预览）→ 写 exposure(held_until=now+10min, committed=false)
确认导出/布置              → committed=true（正式占用曝光窗口）
未确认的 hold              → 过期后查询忽略（不占去重窗口）
```

### 4.5 题库管理页（P1.5，原型已验证）

**可交互原型**：[bank.html](../../../design/prototype/bank.html)（列表/详情双栏 + 筛选 + 草稿箱 + 新建/编辑弹层）

| 功能 | 规格 |
| --- | --- |
| 列表 | 题型/知识点/来源/状态筛选 + 关键词（题干/答案/知识点）；题卡含：题型、#编号、来源、状态徽章、综合难度点、知识点权重标签、版本、曝光与班级正确率 |
| Tab | 全部 / 正常 / **草稿箱**（draft 状态：AI 变式待校验、教师手动待补全） |
| 详情 | 题干+选项、答案与解析（可折叠）、**知识点映射（权重 −/＋ 步进调整，保存自动归一化）**、五维难度画像、使用统计（来自作答事件：曝光/最近使用/班级正确率）、版本历史 |
| 操作 | 编辑（改内容→版本 +1，历史锚定旧版）、停用/恢复、新建（多选知识点，无知识点不允许保存） |
| 管理检索参数面 | 对齐 MathBank CLI 的参数集（关键词/题型/难度/关联题族），见[参考吸收建议 §2.4](./参考吸收建议.md) |

**设计要点**：详情里的"班级正确率/曝光"直接读作答事件统计——题库不是静态仓库，而是带使用反馈的活数据；这也是与 MathBank（无学生数据）的本质差异。

## 5. 关键流程

```
ingestion confirm → 批量建题（source=exam_import, 映射=AI+教师确认结果）
practice 预览     → :select 检索 + soft-hold 曝光
practice 确认     → 曝光 committed
教师改题         → 新版本行，旧行 retire，历史事件不受影响
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 映射权重和 ≠ 1 | 服务端保存时自动归一化（记录归一化前原值进 meta） |
| 一题挂到已被禁用的 kp | 允许保存；选题检索时按可见树过滤，提示教师 |
| retire 有历史事件的题 | 事件回放正常（旧行仍在）；仅新选题不可见 |
| AI 变式题（P3） | verify_status != passed 的题**永不进入** :select 结果 |
| 题干含图片 | P1 存图片引用（file 模块 URL），stem 存文字描述 + `has_image` 标记 |

## 7. 验收标准（DoD）

- [ ] 版本化：改题后旧事件回放仍取旧版本内容（集成测试）
- [ ] 选题服务：曝光排除（14 天内 committed 不再出）、prefer_retest 置顶、难度带过滤均正确
- [ ] soft-hold：预览后 10 分钟内同生重复生成不撞题；过期后可复用
- [ ] kp_count 触发器同步 + 权重自动归一化
- [ ] 25 题试卷 confirm 后建题与映射落库完整（与 ingestion 联调）
- [ ] 题库管理页：筛选/草稿箱/映射权重调整（归一化）/停用恢复/新建入草稿箱全流程（原型 bank.html 对应）

## 8. 演进预留

- P2：题库批量导入（Excel/Word 标准格式）；曝光窗口租户可配
- P3：AI 变式题流水线（母题→变式→sympy 验算→人工抽检→active），见 [12-ai §5]((.././12-ai.md/./12-ai.md.md))
