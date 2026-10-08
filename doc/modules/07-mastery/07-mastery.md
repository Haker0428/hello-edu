# 07 · 掌握度引擎（mastery）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | **核心域** / P1 |
| 上游设计 | [架构文档 §4.6 / ADR-2 / ADR-4](../../架构与模块详细设计.md) |
| 前端原型 | 证据链抽屉（heatmap.html）、画像知识点行展开（student.html） |
| 依赖 | `student_answer_event`（只读消费）、question_kp_map（分摊权重）、knowledge（前置链）、platform（租户参数） |
| 被依赖 | profile、dashboard、practice（全部读 mastery_state） |

## 1. 模块定位与边界

**职责**：消费作答事件，维护每个 `(student, knowledge_point)` 的 `Mastery + Confidence` 状态；提供证据可解释接口；支持全量重放与策略替换。

**明确不做**：
- 不生产事件（ingestion 生产，本模块只消费）
- 不做画像聚合（profile 模块）
- 不做练习决策（practice 模块）
- P1 不做 BKT/IRT/DKT（接口预留，见 §8）

**三条硬约束（架构不变量在此模块落地）**：
1. 事件表 append-only，本模块**只读**
2. `mastery_state` 永远可由「有效事件 + 确定性策略」全量重算
3. 策略是纯函数：`f(state, evidence) → state`，无副作用、无随机性

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/students/{id}/mastery?kp_ids= | 状态查询（含教师可读档位） |
| GET | /api/students/{id}/mastery/{kp_id}/explain | **证据链**（可解释性核心接口） |
| POST | /api/admin/replay | 全量重放（算法升级/数据修复，school_admin） |
| GET | /api/admin/strategies | 已注册策略与当前生效版本 |
| （内部） | Celery 任务 `mastery.update_batch(batch_id)` | 06 commit 触发 |
| （内部） | Celery 任务 `mastery.daily_decay` | 每日 02:00 置信度衰减 |
| （内部） | Service `MasteryService.apply(evidence)` | 供 P3 学生端实时作答调用 |

**explain 响应结构**：

```json
{
  "data": {
    "student": {"id": 101, "name": "李想"},
    "kp": {"id": 1206, "name": "移项"},
    "state": {"mastery": 38, "confidence": 72, "evidence_count": 9,
              "readable": "未掌握", "strategy_version": "exp_v1"},
    "prereq_chain": [
      {"kp": "整式运算", "m": 55}, {"kp": "合并同类项", "m": 48},
      {"kp": "去括号", "m": 44, "breakpoint": true}, {"kp": "移项", "m": 38}
    ],
    "evidence": [
      {"date": "10-28", "src": "月考", "stem": "解方程：3x+5=2x-1",
       "score": 1, "max": 5, "E": 20, "alpha": 0.31, "map_conf": 0.88,
       "weight_to_kp": 0.2}
    ],
    "formula_note": "M ← (1−α)·M + α·E"
  }
}
```

## 3. 数据模型

```sql
CREATE TABLE student_answer_event (      -- 事实源，append-only，本模块只读
  id          BIGSERIAL PRIMARY KEY,
  school_id   BIGINT NOT NULL,
  student_id  BIGINT NOT NULL,
  question_id BIGINT NOT NULL,           -- 锚定题目版本（见 04 §4.3）
  exam_id     BIGINT,
  is_correct  BOOLEAN,
  score       NUMERIC(5,1),
  max_score   NUMERIC(5,1) NOT NULL,
  evidence    JSONB NOT NULL DEFAULT '{}',
  source      VARCHAR(16) NOT NULL,      -- excel | answer_card | photo | manual | app
  batch_id    UUID,                      -- 撤销追溯单元（JOIN import_batch 过滤 revoked）
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sae_student ON student_answer_event(student_id, occurred_at);
CREATE INDEX idx_sae_batch  ON student_answer_event(batch_id);
-- 触发器：拒绝 UPDATE / DELETE

CREATE TABLE mastery_state (             -- 物化快照（可全量重算）
  student_id       BIGINT NOT NULL,
  kp_id            BIGINT NOT NULL,
  mastery          NUMERIC(5,2) NOT NULL,    -- 0~100
  confidence       NUMERIC(5,2) NOT NULL,    -- 0~100
  evidence_count   INT NOT NULL DEFAULT 0,
  last_evidence_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,              -- 最近"验证型"作答（衰减基准）
  readable_status  VARCHAR(16),              -- 档位（写时物化，读时免算）
  strategy_version VARCHAR(16) NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, kp_id)
);
```

## 4. 核心算法（ExponentialV1，完整定义）

### 4.1 证据评分 E

```
E_raw = score / max_score × 100
E     = E_raw × independence × hint × map_conf        （clamp 到 [0,100]）

independence：非独立完成 ×0.7（教师标注/抄作业标记）
hint         ：使用提示   ×0.85
map_conf     ：题目-知识点映射置信度（0~1，直乘——标注不可靠则证据打折扣）
```

### 4.2 学习率 α

```
α = base_alpha(0.18) × difficulty_gain × confidence_damp      （clamp [0.05, 0.6]）

difficulty_gain   ：答对时 = 1 + 0.25 × (综合难度 − 3)，综合难度 = 五维均值(1~5)
                    → 难题做对证据更强；答错时 = 1.0
confidence_damp   ：clamp(1 − 0.6 × C/100, 0.3, 1.0)
                    → 数据多且确定时 α 收紧，偶然失误不致画像剧烈波动（需求 5.2）
```

### 4.3 状态更新

```
M' = (1 − α)·M + α·E
C' = min(100, C + 10 / (1 + 0.15·n))       # n 为该 kp 已有证据数：增量递减
n' = n + 1
last_evidence_at / last_verified_at = 事件时间
```

### 4.4 一题多知识点的证据分摊（需求 4.1 的落地）

```
设题目映射 {去括号:0.3, 移项:0.3, 合并同类项:0.2, 有理数运算:0.2}
对每个 kp 独立执行 apply(state_kp, E_kp = E × weight_kp)   # α 各自按该 kp 状态计算
效果：综合题对单一薄弱点的冲击被 weight 稀释，画像不失真
容错：Σweight ≠ 1（历史数据）→ 按原值分摊，不强行归一（重放口径一致）
```

### 4.5 时间与遗忘（每日衰减任务，需求 5.3）

```
对每个 mastery_state（含 M ≥ 60 的档位）：
  days = now − last_verified_at
  C ← C × 0.5 ^ (days / 90)                # 半衰期 90 天，只降 C 不动 M
  若 C < 55 且 M ≥ 75 → 写一条复习建议（dashboard 规则 stu_review_due 消费）
未学习/低 M 状态不衰减（无遗忘可言）
```

### 4.6 教师可读档位映射（阈值租户可配）

| 档位 | 条件 | 示例色（原型一致） |
| --- | --- | --- |
| 未学习 | evidence_count = 0 | 灰（斜纹） |
| 未掌握 | M < 40 | 红 |
| 学习中 | 40 ≤ M < 60 | 橙 |
| 初步掌握 | 60 ≤ M < 75 | 黄 |
| 熟练 | 75 ≤ M < 90 | 浅绿 |
| 稳定掌握 | M ≥ 90 | 深绿 |

### 4.7 参数表（全部从 `school.settings.mastery` 读取，下为初值）

| 参数 | 初值 | 说明 |
| --- | --- | --- |
| base_alpha | 0.18 | 基础学习率 |
| alpha_bounds | [0.05, 0.6] | 学习率上下限 |
| independence_factor | 0.7 | 非独立折扣 |
| hint_factor | 0.85 | 提示折扣 |
| confidence_gain_base | 10 | 置信增量基数 |
| confidence_gain_decay | 0.15 | 增量随 n 衰减系数 |
| half_life_days | 90 | 置信度半衰期 |
| review_threshold | 55 | 复习检测触发线 |
| level_thresholds | [40,60,75,90] | 档位线 |

> 参数初值为经验值，**P1 后期用真实数据校准**（见 §8 灰度机制）；禁止硬编码在代码中。

## 5. 关键流程

### 5.1 增量更新（事件驱动）

```
06 commit → Celery update_batch(batch_id)
  读取该批事件（按 occurred_at 排序）
  对每条事件：查题目映射 → 对每个 (student, kp)：load state → strategy.apply → save
  幂等：按 (batch_id, event_id) 处理记录表去重
  完成 → 失效 profile/dashboard 缓存（消息）
```

### 5.2 全量重放（算法升级 / revoke 后修复）

```
POST /admin/replay {school_id, strategy_version}
  按 student 分片（每片 ~50 生）并行：
    events = 该生全部有效事件（JOIN import_batch 过滤 revoked）按时间排序
    state  = fold(strategy.initial(), events)     # 纯函数折叠
    覆写 mastery_state（strategy_version 标记）
  规模：单生数千事件 < 1s；全校夜间跑完
```

### 5.3 策略接口（可替换性的保证）

```python
class MasteryStrategy(Protocol):
    version: str
    def initial(self) -> MasteryState: ...
    def apply(self, state: MasteryState, ev: AppliedEvidence) -> MasteryState: ...
# ExponentialV1 实现上述纯函数；P3 的 BKT/IRT 实现同一接口
# 灰度：按校切换策略版本 → 双跑对比（/admin/strategies/compare）→ 全量重放切换
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 题目无 kp 映射 | 事件跳过 + 告警日志（不阻断批次） |
| 学生新建档（无初始状态） | initial：M=50, C=30, n=0（中性先验，首条证据即快速拉偏） |
| 事件 occurred_at 乱序（补录旧考试） | 按 occurred_at 排序后重放该生（不增量 apply） |
| revoke 批次 | 见 [06 §4.4]((.././06-ingestion-score.md/./06-ingestion-score.md.md))：逻辑排除 + 定向重放 |
| 同一 (student,kp) 短期大量事件（题海） | confidence_gain 递减天然抑制；另设单日证据上限 20/kp（防刷） |
| 租户改阈值 | 只影响档位展示（readable 重算），不影响 M/C 数值 |

## 7. 验收标准（DoD）

单元测试场景集（全部必须通过）：

- [ ] 新学生首考全对 → M 快速上移、C 增长快；再考一次全对 → M 增幅收窄（边际递减）
- [ ] 数据充分（n=15, C=85）时一次 0 分 → M 下降 ≤ 12（稳定性）
- [ ] 数据稀少（n=2, C=45）时一次 0 分 → M 下降 ≥ 25（敏感）
- [ ] 一题 4 知识点 weight 0.2 → 各 kp 收到的 E = 0.2 × E_raw（分摊正确）
- [ ] 非独立 + 提示 + 低映射置信的叠加折扣正确
- [ ] 90 天无验证 → C 减半；M 不变；触发复习建议
- [ ] 全量重放幂等：同一事件流重放两次 mastery_state 完全一致（**最重要测试**）
- [ ] revoke 后重放 = 从未导入（与 06 联调）
- [ ] explain 接口返回的 E/α 与重算值逐条一致

## 8. 演进预留

- P3：BKT 策略（隐含知识概率，参数用 EM 校准）；IRT（题目难度/区分度参与 α）
- P3：双策略灰度对比接口（同校 A/B，对比预测准确率：下次作答对错的 AUC）
- 长期：DKT 仅作离线评估基准，不上线服务（可解释性优先，需求 5.4）
