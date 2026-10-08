# 06 · 成绩导入（ingestion · score）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | 支撑域 / P1 |
| 上游设计 | [架构文档 §4.5](../../架构与模块详细设计.md) |
| 前端原型 | [score-import.html](../../../design/prototype/score-import.html)（三层校验 / 行级修正 / 提交进度） |
| 依赖 | exam/paper 结构、platform（学生名单）、file |
| 被依赖 | **mastery（事件的生产者，全闭环的数据入口）** |

## 1. 模块定位与边界

**职责**：把 Excel 逐题得分变成 `student_answer_event`（append-only 事件）：模板生成、三层校验、行级错误定位、幂等 commit、可撤销。

**明确不做**：
- 不做掌握度计算（只生产事件，mastery 消费）
- P1 不做答题卡识别/在线作答（新增仅体现为 `source` 枚举扩展，事件结构不变）

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/exams/{id}/score-template | 下载模板（行=学生预填名单，列=题目） |
| POST | /api/exams/{id}/scores:import | 上传 Excel → 解析校验 → 返回预览报告（**不写事件**） |
| POST | /api/exams/{id}/scores:commit | 确认导入：staging → 事件批量写入 → 触发 mastery（需 Idempotency-Key） |
| POST | /api/batches/{batch_id}:revoke | 撤销整批（逻辑排除 + 定向重放，见 §4.4） |
| GET | /api/exams/{id}/batches | 该考试的导入批次与状态 |

**校验报告响应结构**：

```json
{
  "data": {
    "batch_id": "8f3a…",
    "checks": {
      "roster":  {"exact": 41, "fuzzy": 1, "issues": 1},
      "range":   {"checked": 1049, "issues": 1},
      "completeness": {"missing_cells": 8, "missing_note": "2 人各缺 4 题"}
    },
    "issues": [
      {"row_no": 17, "seq": 14, "code": "E201",
       "detail": "得分 6 超出该题满分 5", "current": 6},
      {"row_no": 23, "code": "E101",
       "detail": "学号 20240338 不在班级名单", "candidates": [{"student_id": 140, "name": "方远"}]}
    ],
    "preview": {"rows": 5, "cols": 25, "committed_ready": false}
  }
}
```

## 3. 数据模型

```sql
CREATE TABLE import_batch (
  id         UUID PRIMARY KEY,               -- Idempotency-Key
  exam_id    BIGINT NOT NULL,
  school_id  BIGINT NOT NULL,
  file_name  VARCHAR(255),
  status     VARCHAR(12) NOT NULL,           -- validating | preview | committed | revoked | failed
  report     JSONB,                          -- 校验报告（预览结果）
  event_count INT,
  created_by BIGINT, created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE score_staging (                 -- commit 前暂存（预览确认的对象）
  batch_id  UUID NOT NULL REFERENCES import_batch,
  row_no    INT NOT NULL,
  student_id BIGINT,
  seq       INT NOT NULL,                    -- 卷面题号
  score     NUMERIC(5,1),
  issue_code VARCHAR(24),                    -- 空 = 有效
  PRIMARY KEY (batch_id, row_no, seq)
);
```

事件表 `student_answer_event` 归 mastery 模块所有（见 [07-mastery §3]((.././07-mastery.md/./07-mastery.md.md))），本模块只写不读。

## 4. 核心逻辑

### 4.1 模板生成

```
行：该班学生（按学号排序，预填学号+姓名，防教师填错）
列：试卷 confirm 后的题目（表头 = 题号 + 分值，如 "Q14 (5分)"）
附注行：缺考留空说明（留空=未参加不产生证据；填0=参加且全错）
```

### 4.2 三层校验（错误码表）

| 码 | 层 | 含义 | 处理方式 |
| --- | --- | --- | --- |
| E101 | 名单 | 学号不匹配 | 给候选（学号相近/姓名相同），人工选择或跳过 |
| E102 | 名单 | 姓名不匹配 | 同上 |
| E201 | 范围 | 得分 > 题目满分 | 行内修正（输入框定位到单元格） |
| E202 | 范围 | 得分 < 0 | 行内修正 |
| E301 | 完整性 | 某生缺某题 | 可"标记请假"后放行 |
| E302 | 完整性 | 重复行 | 保留后一行，报告提示 |
| E303 | 完整性 | 名单学生整行缺失 | 报告列出，可放行（未参加） |

**存在 E101/E201 级错误时 commit 被阻止**；E301/E303 可带病放行（缺考语义）。

### 4.3 commit（幂等写入）

```
commit(batch_id):
  1. 幂等检查：event 表中该 batch_id 已有事件 → 直接返回上次结果
  2. staging 有效行 → 组装事件：
     { student_id, question_id(试卷 confirm 时回填), exam_id,
       score, max_score, is_correct = (score == max),
       evidence: { rubric_scores?: 按得分点列则解析, source_type: 'excel' },
       source: 'excel', batch_id, occurred_at: 考试日期 }
  3. 批量 INSERT（单事务，42×25 ≈ 1050 行，秒级）
  4. 投递 Celery: mastery.update_batch(batch_id)
  5. batch.status = committed
```

### 4.4 撤销（revoke）——与 append-only 的兼容方案

> 指数更新不可交换，**负向补偿事件无法精确回滚**。正确方案是"逻辑排除 + 定向重放"：

```
revoke(batch_id):
  1. import_batch.status = revoked（事件本身不动，满足 append-only）
  2. 计算受影响 (student_id, kp_id) 集合 = 该批事件按映射分摊的并集
  3. 对每个受影响 student 触发定向重放：重放该生全部有效事件
     （有效 = JOIN import_batch 且 status != revoked），重算 mastery_state
  4. 画像/看板缓存失效
规模：单批撤销 → 每生事件量数千级，分片并行，分钟内完成
```

### 4.5 缺考语义（UI 必须明示）

| Excel 单元格 | 语义 | 产生事件 | 证据效果 |
| --- | --- | --- | --- |
| 留空 | 未参加 | 无 | 无影响 |
| 0 | 参加且全错 | 有（score=0） | 强负向证据 |

## 5. 关键流程

```
模板下载 → 教师线下填分 → 上传（:import 校验+预览，不落事件）
  → 处理 issues（行级修正/请假标记）→ :commit（幂等，写事件）
  → Celery：mastery 更新 → profile 刷新 → dashboard 异常识别
  → 前端展示处理进度 → 跳转看板
（发现录错）→ :revoke → 逻辑排除 + 定向重放 → 修正后重新导入
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 同一考试重复 :commit | 幂等键命中 → 返回首次结果，不重复写事件 |
| 同一考试想覆盖导入 | 引导先 revoke 旧批次再导新（不做静默覆盖） |
| Excel 列序与模板不符 | 表头指纹校验（题号+分值匹配）不通过 → E100 拒绝整个文件 |
| 得分含 0.5（步骤分） | 支持 NUMERIC(5,1)；rubric 列存在时解析进 evidence.rubric_scores |
| commit 进行中又 revoke | 任务队列串行化（同一 student 的重放互斥，Celery 按 student 分片） |
| 教师把答案行当成成绩行粘贴 | 范围校验大量 E201 → 阻止 + 明显提示 |

## 7. 验收标准（DoD）

- [ ] 幂等：同 batch 重复 commit 事件数不变（集成测试）
- [ ] 校验：7 类错误码构造用例全部正确识别且行/列定位准确
- [ ] commit 后事件字段完整（含 evidence、batch_id、occurred_at），触发 mastery 任务
- [ ] revoke：导入→撤销→重放后 mastery 与"从未导入"状态一致（**核心正确性测试**）
- [ ] 缺考留空不产生事件、填 0 产生强负证据的区分测试
- [ ] 1050 事件单事务 < 3s

## 8. 演进预留

- P2：`source=answer_card`（答题卡识别，走同一 staging→校验→commit 管道，仅入口不同）
- P2：`source=manual`（教师改卷逐题点击录入，移动端）
- P3：`source=app`（学生端作答直接回流）
