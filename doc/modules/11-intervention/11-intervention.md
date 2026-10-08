# 11 · 干预闭环（intervention）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | 核心域 / **P2** |
| 上游设计 | [架构文档 §4.10](../../架构与模块详细设计.md) |
| 前端原型 | 画像页右栏"干预记录"时间线（student.html，已预览交互） |
| 依赖 | dashboard（异常触发源）、mastery（效果判定的数据）、practice（练习型干预载体） |
| 被依赖 | 长期：教学策略推荐（P3 数据集） |

## 1. 模块定位与边界

**职责**：记录「问题 → 干预 → 后续表现 → 效果判定」全链路，把干预从"老师心里有数"变成可追踪、可复盘的数据资产。

**明确不做**：
- 不做异常发现（dashboard 的职责，本模块从 anomaly 发起）
- P2 不做自动推荐干预方式（只记录与判定；推荐是 P3 数据积累后的事）

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/interventions | 创建（可从 anomaly 一键发起，快照冻结） |
| GET | /api/interventions?student_id=&status= | 列表（画像右栏时间线） |
| PATCH | /api/interventions/{id} | 补充记录（干预内容、结束） |
| GET | /api/interventions/{id}/effect | 效果判定详情 |
| GET | /api/classes/{id}/intervention-summary | 班级干预概览（已采取/效果分布） |

**创建请求**：

```json
{
  "student_id": 101, "kp_id": 1206,
  "anomaly_id": 62,                       // 可选：触发源
  "type": "targeted_practice",            // reteach | targeted_practice | tutoring | parent_contact
  "practice_plan_id": 77,                 // 练习型干预的载体
  "note": "移项专项 8 题，课后完成",
  "track_window_days": 14
}
```

## 3. 数据模型

```sql
CREATE TABLE intervention (
  id            BIGSERIAL PRIMARY KEY,
  school_id     BIGINT NOT NULL,
  student_id    BIGINT NOT NULL,
  kp_id         BIGINT,                   -- 目标知识点（可空=整体性干预）
  anomaly_id    BIGINT REFERENCES anomaly,
  type          VARCHAR(24) NOT NULL,     -- reteach | targeted_practice | tutoring | parent_contact | other
  practice_plan_id BIGINT,                -- 关联练习（如有）
  trigger_snapshot JSONB NOT NULL,        -- 冻结：{mastery:42, confidence:71, date:"10-12", rule:"stu_kp_weak"}
  note          TEXT,
  status        VARCHAR(12) DEFAULT 'in_progress',  -- in_progress | tracking | concluded
  track_until   TIMESTAMPTZ NOT NULL,     -- 效果判定截止（创建日 + track_window_days）
  outcome       JSONB,                    -- 判定结果（见 §4.2）
  created_by    BIGINT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_intv_student ON intervention(student_id, created_at DESC);
```

## 4. 核心逻辑

### 4.1 状态机

```
in_progress（干预进行中，教师可补充记录）
   → 手动结束或窗口过半 → tracking（等待后续表现）
   → 到达 track_until   → Celery 判定 job → concluded（写 outcome）
```

### 4.2 效果判定算法

```
对目标 kp：
  t0 = trigger_snapshot.mastery
  t1 = 判定时 mastery_state.mastery
  delta = t1 − t0
判定档位：
  delta ≥ 15        → "显著改善"     （例：42 → 76）
  5 ≤ delta < 15    → "改善"
  −5 ≤ delta < 5    → "无明显变化"
  delta < −5        → "持续下滑"（提示换干预方式）

outcome = {delta, verdict, t0, t1, judged_at, events_in_window: n}
```

**归因诚实原则（硬性产品规则）**：所有展示措辞用「干预后变化」，**禁止**「干预导致/疗效」类因果表述——同期的自然成长、其他教学活动不可剥离。UI 文案与 API 字段命名统一遵守。

### 4.3 判定 job

```
每日 04:00 扫描 track_until 到期的 tracking 记录 → 逐条判定 → concluded
异常：判定时目标 kp 无数据（学生长期未参加）→ outcome.verdict = "数据不足"
```

## 5. 关键流程

```
dashboard 异常卡 → [记录干预] → 创建（快照冻结当时的 M/C/日期）
→ 教师执行（练习型自动关联 practice_plan）
→ 批改回流（成绩导入）→ mastery 更新
→ 窗口到期 → 判定 job → outcome 写入
→ 画像右栏时间线呈现「10-12 专项练习 · 42%→56% · 有效」
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 干预期间学生又做同类练习 | 无冲突：judgment 只看目标 kp 的 M 变化 |
| 同一学生同 kp 重复干预 | 允许（新一轮快照独立）；列表按时间线展示 |
| 窗口内无任何新事件 | verdict = "数据不足"，提示安排检测 |
| 目标 kp 被禁用/教材变更 | 判定照常（mastery_state 保留），附 note |
| 教师忘记手动结束 | 窗口到期自动 concluded（in_progress 直接到判定） |

## 7. 验收标准（DoD）

- [ ] 状态机流转完整（in_progress → tracking → concluded）
- [ ] 判定：构造 42→76 场景 → verdict=显著改善、delta=34
- [ ] 归因措辞检查：API 与前端全量文案无因果表述（文案 lint）
- [ ] 快照冻结：干预后 mastery 变化不影响 trigger_snapshot
- [ ] 画像右栏时间线与原型一致（日期/类型/变化/判定）

## 8. 演进预留

- P2：班级干预概览（班主任视角）；干预与练习双向追溯
- P3：策略推荐数据集 —— 「学生特征（画像切片）× 干预类型 × 结果」聚合视图，为推荐模型供数（需求 §10 的长期壁垒）
