# 05 · 试卷接入（ingestion · paper）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | 支撑域 / P1 |
| 上游设计 | [架构文档 §4.4](../../架构与模块详细设计.md) |
| 前端原型 | [paper.html](../../../design/prototype/paper.html)（步骤条 / 低置信确认队列 / 高置信折叠） |
| 依赖 | ai（拆题/标注）、question（建题）、knowledge（标注候选）、file（原件存储） |
| 被依赖 | 成绩导入（生成模板的前提）、exam（考试结构） |

## 1. 模块定位与边界

**职责**：把纸质/PDF/Word 试卷变成系统内结构化、已确认标注的题目集合：抽取 → 拆题 → 标注 → 教师确认 → 生成成绩导入模板。

**明确不做**：
- 不做手写 OCR 与拍照增强（P2）
- 不做成绩录入（06 模块）
- LLM 输出永远是**待确认草稿**，本模块负责置信度分流与确认交互（架构不变量 4）

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/papers:upload | 上传原件（multipart），创建 paper，触发异步流水线 |
| GET | /api/papers/{id} | 状态与进度（前端轮询） |
| POST | /api/papers/{id}:retry | 从当前失败步骤重试（断点续跑） |
| GET | /api/papers/{id}/review-queue | 待确认题目（低置信），含 AI 建议映射 |
| PATCH | /api/paper-questions/{id} | 教师修正题干/分值/映射（回流评测集） |
| POST | /api/paper-questions/{id}:confirm | 确认单题标注 |
| POST | /api/papers/{id}:confirm | 全卷确认 → 批量建题 + 创建 exam + 生成模板下载地址 |
| GET | /api/papers/{id}/score-template | 下载成绩导入 Excel 模板（见 06） |

**review-queue 响应结构**：

```json
{
  "data": {
    "auto_passed": 21,
    "pending": [
      {"paper_question_id": 88, "seq": 14,
       "stem": "解方程：2(x-3)=3(x+1)-6",
       "suggested_maps": [
         {"kp_id": 1209, "kp_name": "方程求解综合", "weight": 0.5, "confidence": 0.62},
         {"kp_id": 1204, "kp_name": "去括号", "weight": 0.3, "confidence": 0.58}],
       "llm_note": "综合解方程：去括号与移项的权重分配置信度不足"}
    ]
  }
}
```

## 3. 数据模型

```sql
CREATE TABLE paper (
  id           BIGSERIAL PRIMARY KEY,
  school_id    BIGINT NOT NULL,
  class_id     BIGINT NOT NULL,
  title        VARCHAR(128),
  source_file_id BIGINT NOT NULL REFERENCES file_object,
  total_score  NUMERIC(6,1),               -- 卷面总分（抽取识别或教师补填）
  status       VARCHAR(16) NOT NULL DEFAULT 'uploaded',
  -- uploaded | extracting | extracted | splitting | split | annotating | annotated
  -- | confirming | confirmed | failed
  error        JSONB,                      -- {step, message, retriable}
  created_by   BIGINT, created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE paper_question (
  id          BIGSERIAL PRIMARY KEY,
  paper_id    BIGINT NOT NULL REFERENCES paper,
  seq         INT NOT NULL,                -- 卷面题号
  stem        TEXT,
  type        VARCHAR(16),
  score       NUMERIC(5,1),                -- 该题分值
  question_id BIGINT REFERENCES question,  -- confirm 后回填
  llm_raw     JSONB,                       -- 拆题原始输出（评测集）
  ann_raw     JSONB,                       -- 标注原始输出 [{kp_id,weight,confidence,reason}]
  teacher_fixed BOOLEAN DEFAULT false,     -- 教师是否修正（评测集标记）
  conf_checked  BOOLEAN DEFAULT false,     -- 低置信题：教师已确认
  PRIMARY KEY (paper_id, seq)
);
```

## 4. 核心逻辑

### 4.1 状态机（每步产物落库，可断点续跑）

```
uploaded ──抽取──▶ extracted ──拆题──▶ split ──标注──▶ annotated ──教师确认──▶ confirmed
   │ (PyMuPDF)        │ (LLM+Schema)        │ (LLM+图谱约束)    │ (置信度分流)
   └─ 任意步骤失败 → status=failed + error{step} → :retry 从该步重跑（前面产物保留）
```

### 4.2 抽取（extracted）

- PyMuPDF 提取文本 + 块级坐标；按阅读顺序拼接，页眉页脚过滤。
- **文字层为空**（扫描件）→ 直接 failed，错误信息引导"转存 Word 或用文字版 PDF"（P1 不做 OCR）。
- 尝试从卷首识别卷面总分（"满分 120 分"模式），识别不到留空由教师补填。

### 4.3 拆题（split）

LLM 结构化输出（JSON Schema 约束，规格见 [12-ai §4.1]((.././12-ai.md/./12-ai.md.md))）：

```json
{"questions": [
  {"seq": 1, "type": "choice", "stem": "…", "options": ["A…","B…"],
   "answer": "B", "score": 3.0}
], "total_score": 120}
```

**校验与重试**：
1. `seq` 连续（1..N，允许跳过分值 0 的附加题并标记）
2. `Σscore == 卷面总分`（总分已知时）；不等 → 错误信息回喂 LLM 重试
3. `type` ∈ 枚举；stem 非空
4. 结构校验失败重试 ≤ 2 次，仍失败 → failed（教师可手动录入题目兜底）

### 4.4 标注（annotate）

- **图谱候选约束**：注入当前教材全部 active 知识点（编号/名称/一句话描述/层级），要求输出仅含候选内 `kp_id`；服务端再校验一次，候选外 ID 直接丢弃该条并降置信。
- 输出 `[{kp_id, weight, confidence, reason}]`，weight 服务端归一化。
- 题级置信度 = 各映射 confidence 的 **最小值**。

### 4.5 置信度分流（confirming，降低教师摩擦的关键设计）

```
题级置信度 ≥ 0.9        → 自动通过（前端折叠可复查）
0.6 ≤ 置信度 < 0.9      → 确认队列（默认选中 AI 建议，一键确认）
置信度 < 0.6            → 确认队列 + 高亮警告（可能需要教师手动选 kp）
```

教师修正（PATCH）写 `teacher_fixed=true`，原 AI 输出保留在 `llm_raw/ann_raw` → 沉淀为标注评测集。

### 4.6 全卷确认（confirmed）

事务内：建 question（source=exam_import）+ 映射 + Rubric 占位 → 回填 question_id → 创建 exam（关联 paper/class）→ 生成成绩模板（06 模块接口）。

## 5. 关键流程

```
上传 → [异步] 抽取→拆题→标注 → 前端轮询到 annotated
     → 教师处理确认队列（目标：≤90 秒）→ :confirm
     → 建题 + 建 exam + 模板就绪 → 跳转成绩导入
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 一题多小问（含 (1)(2)） | 拆题保持一题，stem 含小问；Rubric 按小问建步骤（P1 教师可后补） |
| 题干含图 | stem 存文字 + `has_image`；确认界面提示"图题请核对文字描述" |
| 答案缺失 | 允许空（成绩导入不依赖答案，批改在纸面）；练习复用该题时提示补答案 |
| 分值识别错误 | 教师 PATCH 分值 → 重新校验 Σ；不等则阻止 confirm |
| LLM 超时/限流 | 重试（指数退避 ×3）→ failed 可手动 retry；队列任务幂等（paper 状态机保证） |
| 重复上传同一试卷 | 不去重（允许同名多卷），由 exam 标题区分 |

## 7. 验收标准（DoD）

- [ ] 样例集 10 份真实试卷：拆题题号/分值准确率 ≥ 90%，分值总和校验 100% 拦截不一致
- [ ] 标注：自动通过率 ≥ 70%（高置信正确率 ≥ 95% 抽检）
- [ ] 断点续跑：标注步 failed 后 retry 不重复拆题
- [ ] confirm 后 25 题 × 平均 2.4 映射全部落库，exam 与模板正确生成（与 06 联调）
- [ ] 扫描件给出明确引导而非报错堆栈

## 8. 演进预留

- P2：拍照/OCR 接入（新增 extract 来源，状态机不变）；模板试卷（本校历史卷沉淀为题库）
- P3：标注评测集驱动 prompt 自动调优
