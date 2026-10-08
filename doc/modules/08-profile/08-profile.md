# 08 · 画像（profile）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | **核心域** / P1 |
| 上游设计 | [架构文档 §4.7](../../架构与模块详细设计.md) |
| 前端原型 | [student.html](../../../design/prototype/student.html)（三维度分级展示） |
| 依赖 | mastery（状态）、question（Rubric）、knowledge（章节结构） |
| 被依赖 | practice（练习依据）、dashboard（异常输入）、intervention（P2） |

## 1. 模块定位与边界

**职责**：把 `mastery_state` 聚合为学生的三维度画像（Knowledge / Skill / Error Pattern），按数据可得性**诚实分级**；管理画像缓存。

**明确不做**：
- 不算掌握度（mastery 的职责）
- 不做异常识别（dashboard 的职责）
- 不承诺 P1 数据支持不了的精度（Skill 标"推测"、Error Pattern 未激活则不展示）

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/students/{id}/profile | 完整画像（三维度 + 维度可用性说明） |
| GET | /api/classes/{id}/kp-summary | 班级知识点汇总（均值/弱项人数，看板知识点视图用） |
| GET | /api/students/{id}/profile/report | 学期画像报告（PDF，家长会/教研用，P2） |

**profile 响应结构**：

```json
{
  "data": {
    "student_id": 101,
    "dimensions": {
      "knowledge": {
        "available": true,
        "by_chapter": [
          {"chapter": "第二章 · 整式的加减",
           "kps": [{"kp": "去括号", "m": 44, "c": 71, "readable": "学习中"}]}
        ]},
      "skill": {
        "available": true, "estimate_only": true,
        "note": "基于知识点→能力静态映射的间接推测，仅供参考",
        "items": [{"skill": "计算能力", "score": 72}, {"skill": "建模能力", "score": 44}]},
      "error_pattern": {
        "available": false,
        "reason": "需要解题过程数据（步骤得分点/手写识别）后开放",
        "items": []}
    },
    "flags": {"risk": "high", "weak_count": 3, "review_due": 0}
  }
}
```

## 3. 数据模型

```sql
CREATE TABLE skill (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(32) NOT NULL UNIQUE       -- 计算能力 / 建模能力 / 阅读信息提取 / 逻辑推理
);

CREATE TABLE kp_skill_map (              -- 知识点 → 能力 静态映射（图谱冷启动时随 LLM 拆解产出，人工审定）
  kp_id BIGINT NOT NULL REFERENCES knowledge_point,
  skill_id BIGINT NOT NULL REFERENCES skill,
  weight NUMERIC(3,2) NOT NULL,
  PRIMARY KEY (kp_id, skill_id)
);

CREATE TABLE error_type (                -- 错误模式体系（与 knowledge_point 完全独立，需求 §6）
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(64) NOT NULL UNIQUE       -- 符号错误 / 漏条件 / 计算粗心 / 步骤跳跃 / 单位错误…
);

CREATE TABLE student_error_event (       -- P2：Rubric 数据激活后由 LLM 辅助归类 + 教师确认
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL,
  error_type_id BIGINT NOT NULL REFERENCES error_type,
  source_event_id BIGINT NOT NULL REFERENCES student_answer_event,
  rubric_step INT,                       -- 错在哪个步骤
  confirmed_by_teacher BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

> Knowledge 维度无独立表：读时聚合 `mastery_state`（画像不落宽表，维度会持续演进——架构决策）。

## 4. 核心逻辑

### 4.1 维度可用性判定（技术诚实的落点）

```
has_rubric = 该生存在 evidence.rubric_scores 非空的事件
knowledge      : 恒可用
skill          : 恒可用但 estimate_only = true（P2 起用时间/难度数据校准后才可转正）
error_pattern  : available = has_rubric（Excel 逐题对错无法区分"符号错"与"粗心"，不展示）
```

### 4.2 Knowledge 聚合

```
按章节分组（knowledge 树结构）：
  章节 rollup = 子知识点 M 的等权平均（章节值仅供导航，不参与档位判定）
  章节提示 = 组内 min（"本章薄弱点：去括号 44"）
前置链视图：调 knowledge.prerequisite_chain(kp)，逐节点带 M，标记首个 <60 的前置为断点
```

### 4.3 Skill 估算（降级模式）

```
skill_score = Σ(mastery_kp × w_kp) / Σ(w_kp)   # 对每个 skill，遍历有数据的映射 kp
展示规则：estimate_only=true，UI 必须显示"推测"标签（原型已落实）
校准路径（P2）：引入作答时间（快而准→计算能力强）与难度画像回归，转 estimate_only=false
```

### 4.4 Error Pattern 激活（P2，规则预置）

```
Rubric 得分点 × scoring_rubric.error_hint → LLM 归类建议 → 教师确认队列（复用 05 的置信度分流模式）
画像展示：top-N 模式 + 频次 + 最近例题（"符号错误 7 次 · 最近：10-28 Q14 步骤②"）
原则：知识点与错误模式是两套独立体系 —— "移项"是 Knowledge，"移项后未变号"是 Error Pattern
```

### 4.5 缓存策略

```
Redis key: prof:{school}:{student}:{strategy_version}   TTL 1h
失效时机：mastery 更新完成消息 → 删除该生全部 prof:*（简单可靠，重算毫秒级）
班级汇总: prof:cls:{class}:{strategy_version}          TTL 10min
```

## 5. 关键流程

```
mastery 更新完成 → 失效缓存 → 下次请求画像时重算（读时聚合）
教师打开学生画像 → profile API → 三维度 + 证据入口（mastery.explain 下钻）
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 学生完全无数据（新建档） | knowledge 显示"未学习"，skill/error 不展示，flags.risk=无档 |
| 章节下知识点全部被教师禁用 | 章节不返回（树过滤） |
| kp_skill_map 缺失（新图谱未做映射） | skill 维度返回 available=false + reason（不显示半成品） |
| estimate 误用风险 | API 层强制：estimate_only=true 时 UI 合同要求显示标签（前端 lint 检查） |
| 学生转班 | 画像跟随 student_id，无班级依赖（与 platform 决策一致） |

## 7. 验收标准（DoD）

- [ ] 三维度可用性判定与数据形态一致（纯 Excel 数据 → error_pattern.available=false）
- [ ] Knowledge 分章聚合与前置链断点标记正确（对照 mastery_state 手工核算）
- [ ] Skill 估算数学正确且响应必含 estimate_only 标志
- [ ] 缓存失效：导入成绩后 10s 内画像接口返回新值
- [ ] 班级汇总（kp-summary）均值/弱项数与原型 heatmap 知识点视图口径一致

## 8. 演进预留

- P2：Rubric → Error Pattern 激活；学期画像报告 PDF；Skill 校准（时间/难度特征）
- P3：跨学科元能力归因（"数学应用题+物理文字题同弱 → 阅读信息提取"），依赖多学科数据积累，班主任视图消费
