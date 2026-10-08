# 10 · 看板与异常识别（dashboard）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | **核心域** / P1 |
| 上游设计 | [架构文档 §4.9](../../架构与模块详细设计.md) |
| 前端原型 | [index.html](../../../design/prototype/index.html)（三问首页）、[heatmap.html](../../../design/prototype/heatmap.html)（热力图/知识点视图） |
| 依赖 | mastery（状态）、profile（汇总）、knowledge（教学范围/前置链）、platform（班级） |
| 被依赖 | intervention（P2，异常是干预的触发源）、practice（动作入口） |

## 1. 模块定位与边界

**职责**：Exception-based Management 的落地——把 42 名学生压缩成「正常 / 需关注 / 高风险」与异常清单；班级热力图数据服务；教师首页三问聚合；**每个异常直接挂可执行动作**（Action Dashboard）。

**明确不做**：
- 不做数据全量展示（不做"所有学生的所有分数"大报表——那是传统成绩系统）
- 不做干预记录（intervention 模块，本模块只负责"发起"入口）

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/classes/{id}/dashboard | **三问聚合**（首页一屏全部数据） |
| GET | /api/classes/{id}/heatmap?chapter=&search= | 热力图矩阵（学生×知识点） |
| GET | /api/classes/{id}/kp-summary | 知识点汇总视图（均值/弱项数/诊断） |
| GET | /api/students/{id}/timeline?kp_id= | 单生单知识点趋势（画像页折线） |
| POST | /api/anomalies/{id}:dismiss | 教师忽略（14 天降噪窗口） |
| POST | /api/anomalies/{id}:action | 动作转发（practice 生成 / intervention 创建） |

**dashboard 响应结构**：

```json
{
  "data": {
    "stats": {"high": 4, "watch": 9, "ok": 29, "data_freshness": "10-28"},
    "q1_class_issues": [
      {"anomaly_id": 55, "rule": "kp_class_weak", "kp": "去分母",
       "avg": 54, "below_count": 38, "actions": ["practice:reteach"]}],
    "q2_students": [
      {"student_id": 101, "name": "李想", "risk": "high",
       "headline": "移项 38% · 前置断点（去括号 44%）",
       "trend": [62, 58, 52, 45, 38], "actions": ["practice", "profile"]}],
    "q3_todos": [
      {"type": "review_due", "text": "安排复习检测：3 人遗忘风险", "count": 3}]
  }
}
```

**heatmap 响应结构**：

```json
{
  "data": {
    "students": [{"id": 101, "name": "李想", "risk": "high"}],
    "kps": [{"id": 1206, "name": "移项", "chapter": "第三章 · 一元一次方程", "has_prereq": true}],
    "cells": [[{"m": 38, "c": 72, "n": 9} | null]],   // null=未学习
    "legend": {"levels": [40, 60, 75, 90], "low_conf": 55}
  }
}
```

## 3. 数据模型

```sql
CREATE TABLE anomaly (
  id          BIGSERIAL PRIMARY KEY,
  school_id   BIGINT NOT NULL,
  class_id    BIGINT NOT NULL,
  student_id  BIGINT,                    -- 学生级异常非空；班级级为空
  kp_id       BIGINT,                    -- 知识点级异常非空
  rule_key    VARCHAR(32) NOT NULL,      -- 见 §4.2 规则表
  params      JSONB NOT NULL,            -- 触发快照（阈值、数值，快照展示用）
  status      VARCHAR(12) DEFAULT 'open',-- open | actioned | dismissed | expired
  first_seen  TIMESTAMPTZ NOT NULL,
  last_seen   TIMESTAMPTZ NOT NULL,      -- 降噪：持续存在只更新，不重复推
  dismissed_until TIMESTAMPTZ,           -- dismiss 后的静默期
  action_taken JSONB,                    -- {type: practice| intervention, ref_id}
  UNIQUE (class_id, student_id, kp_id, rule_key)   -- 降噪 upsert 键
);
```

## 4. 核心逻辑

### 4.1 学生三档分档

```
核心 kp 集 = 当前教学章节的 kp（class.curriculum → 当前章节）
avg = 核心 kp 的 M 均值；min = 核心 kp 的最小 M
high  : avg < 45
watch : 任一核心 kp M < 40 或 avg < 62 或 存在复习候选
ok    : 其余
分档随 mastery 更新异步重算（无独立表，读时算 + Redis 缓存 10min）
```

### 4.2 异常规则表（配置驱动：rule_key → 条件 → 动作映射）

| rule_key | 条件（参数租户可配） | 级别 | 动作入口 |
| --- | --- | --- | --- |
| `stu_kp_weak` | 学生核心 kp `M < 40` | 学生级 | 生成专项练习（practice, 单生单 kp 桶） |
| `stu_prereq_gap` | 当前章节弱 **且** 前置链某节点 `M < 60` | 学生级 | 生成前置诊断练习（practice, prereq 桶） |
| `stu_review_due` | `M ≥ 75 且 C < 55`（遗忘风险） | 学生级 | 安排复习检测（practice, review 桶） |
| `kp_class_weak` | kp 班级均值 `< 60` 且标准差小（分布集中） | 班级级 | 课堂重讲配套练习 + 提示"非个别补差" |
| `stu_decline` | 连续 3 次评估下滑且累计 `> 15` | 学生级 | 标记关注 / 记录干预（P2） |

规则引擎实现：每条规则为纯函数 `f(class_context) → [anomaly]`，按 JSON 配置启用与调参（`school.settings.dashboard.rules`）。

### 4.3 执行时机与降噪

```
触发：06 commit 完成后异步 + 每日 03:00 全量
降噪：按 UNIQUE 键 upsert——open 状态的存量异常只更新 last_seen（不重复出现在待办）
dismiss：教师点"忽略" → dismissed_until = now + 14d，期间该异常不进首页（但热力图仍可见）
expired：条件不再满足（如练习后 M 回升）→ 自动 expired
```

### 4.4 热力图数据服务

```
行：班级学生（risk 点标记），支持 search 过滤
列：知识点（按章节分组，has_prereq 标记 ⤴）；支持 chapter 过滤
规模处理：列 > 20 时前端按章分组懒加载；行 > 60 分页（P1 单班 ≤ 56 直接返回）
单元格 = mastery_state 投影 {m, c, n}；c < 55 附 low_conf 标记（前端角标）
```

## 5. 关键流程

```
成绩 commit → mastery 更新完成 → dashboard.recompute(class_id)
  → 分档重算 + 规则执行 + anomaly upsert → 缓存失效
教师打开首页 → 三问聚合（异常 + 待办 + 数据健康）→ 点动作按钮
  → 转发 practice/intervention → anomaly.status = actioned
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 开学初无数据 | 首页显示引导态（去上传试卷/导名单），不显示空异常 |
| 异常风暴（一次导入产生 50+ 条） | 每生每规则只保留最严重 1 条；首页只推 top 10，其余折叠 |
| kp_class_weak 与多个 stu_kp_weak 重叠 | 正常共存：班级级卡与个别学生卡语义不同，分别展示 |
| 教师 dismiss 后情况恶化 | 数值再降 15+ 时突破静默期重新提醒（可穿透） |
| 跨学科视图（班主任） | 单独聚合接口（各科 risk + 趋势），P2 随 intervention 一起交付 |

## 7. 验收标准（DoD）

- [ ] 五条规则构造用例全部正确触发/不误触发（含 kp_class_weak 的分布集中判定）
- [ ] 降噪：连续两次导入同一异常只保留一条且 last_seen 更新
- [ ] dismiss 14 天静默 + 恶化穿透逻辑正确
- [ ] 分档与原型口径一致（high/watch/ok 阈值测试）
- [ ] heatmap 接口 42×13 < 200ms（缓存命中 < 20ms）
- [ ] 首页每个异常卡的动作按钮都能跳转到正确模块并带上下文（联调）

## 8. 演进预留

- P2：班主任跨学科视图（聚合多科 risk + 共性归因提示）；异常推送（企业微信/钉钉）
- P3：干预效果回流展示在异常卡上（"上次干预：有效 ↑"）
