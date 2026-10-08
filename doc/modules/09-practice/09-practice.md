# 09 · 练习生成（practice）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | **核心域** / P1 |
| 上游设计 | [架构文档 §4.8](../../架构与模块详细设计.md) |
| 前端原型 | [practice.html](../../../design/prototype/practice.html)（策略配置 / 练习卷预览 / 换题） |
| 依赖 | profile（画像）、question（选题服务）、knowledge（前置链）、file（导出） |
| 被依赖 | 成绩导入（作业回流后归因到练习闭环） |

## 1. 模块定位与边界

**职责**：两层结构——Practice Planner（这个学生下一步练什么）+ Question Selector（具体用哪些题）；组卷（统一+个性化）；打印导出；记录为作业等待回流。

**明确不做**：
- 不做出题（题池不足时**降级提示教师**，不擅自 AI 生成——需求 4.3）
- 不做批改与回流解析（成绩导入 + mastery 的职责）

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/practice-plans | 生成（班级/选中学生 + 策略参数），返回预览 |
| GET | /api/practice-plans/{id} | 计划详情与每生题单 |
| POST | /api/practice-plans/{id}:regenerate | 重新生成（换题） |
| POST | /api/practice-plans/{id}:assign | 确认布置 → 创建 exercise（exam 占位），曝光固化 |
| GET | /api/practice-plans/{id}/export?format=pdf\|docx&student_id= | 导出（全班级每生一份 zip，或单生） |
| POST | /api/practice-plans/{id}/items/{q}/swap | 单题替换（保持约束） |

**生成请求**：

```json
{
  "class_id": 3,
  "student_ids": null,                    // null=整班；否则指定名单
  "strategy": {
    "total": 10, "weak": 5, "prereq": 2, "current": 2, "review": 1,
    "common_ratio": 0.6,                  // 统一题占比
    "target_success": 0.7
  }
}
```

## 3. 数据模型

```sql
CREATE TABLE practice_plan (
  id         BIGSERIAL PRIMARY KEY,
  school_id  BIGINT NOT NULL,
  class_id   BIGINT NOT NULL,
  created_by BIGINT NOT NULL,
  strategy   JSONB NOT NULL,              -- 生成时快照（可复现）
  status     VARCHAR(12) DEFAULT 'generated',  -- generated | assigned | closed
  assigned_exam_id BIGINT,                -- assign 后关联（回流归因）
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE exercise_set (               -- 每生一份
  id          BIGSERIAL PRIMARY KEY,
  plan_id     BIGINT NOT NULL REFERENCES practice_plan,
  student_id  BIGINT NOT NULL,
  items       JSONB NOT NULL,             -- [{question_id, bucket: common|weak|prereq|current|review,
                                          --   kp_id, from_retest: bool}]
  PRIMARY KEY (plan_id, student_id)
);
```

曝光日志表在 question 模块（[04 §3]((.././04-question.md/./04-question.md.md))），本模块只读写其接口。

## 4. 核心逻辑

### 4.1 Practice Planner（配比 → 知识点桶分配）

对每个学生（整班 = 逐生跑）：

```
输入：该生画像(mastery_state) + 教学范围(当前章节 kp 列表) + 教学进度
weak    桶：教学范围内 M < 40 的 kp，按 M 升序取 ⌈total×50%⌉ 个（每个 1 题）
prereq 桶：对 weak kp 跑前置断点检测（前置链上 M<60 的最近节点），
           取断点 kp ⌊total×20%⌋ 个 —— 不反复刷高层题（需求 3.3）
current 桶：教学进度接下来 1-2 个 kp（教师本周将讲/刚讲）
review 桶：C < 55 且 M ≥ 75 的 kp，按间隔表 due 日排序（1d/3d/7d/14d）
无弱项的学生：weak 桶自动让位给 current/review（配比守恒，报告说明）
```

### 4.2 Question Selector（选题约束）

```
难度带（自适应难度的实现）：
  目标成功率 ≈ 70% → 按当前 M 选题综合难度：
  M < 40 → band 1-2 ；40-59 → 2-3 ；60-74 → 3 ；≥75（复习）→ 3-4
  实现：调 question:select?difficulty_band=（见 04 §4.2）

约束（按优先级）：
  1. 去重：排除该生近 14 天 committed 曝光
  2. 错题重现优先：该 kp 最近一次做错且之后无对的题 → 置顶复现（from_retest=true）
  3. 间隔重复：review 桶按 due 日升序
降级链：池不足 → 放宽难度带 ±1 → 仍不足 → 该 kp 标记缺题，
        生成结果附"缺题报告"（缺什么、建议教师补充什么类型的题）——绝不静默凑数
```

### 4.3 组卷（Homework = Common + Personalized）

```
统一题（common_ratio，默认 60%）：以"班级整体画像"跑一遍 Planner（弱项=班级均值低的知识点）
  → 全班相同 → 保留班级教学节奏
个性化题（剩余）：按每生 plan 组装
版式：第一部分 统一练习 / 第二部分 个性化练习（原型 sheet 已定样式）
```

### 4.4 assign（闭环锚点）

```
:assign → 创建 exercise 记录（类型=作业，占位 exam：practice_plan.assigned_exam_id）
       → 曝光 soft-hold 转 committed（question 模块）
教师批改后通过成绩导入录入该作业 → 事件自然回流 → mastery 更新 → 闭环完成
（下次生成练习时，本次 from_retest 题的对错即"再验证"信号）
```

## 5. 关键流程

```
教师选对象+策略 → 生成预览（soft-hold 曝光）→ 逐题可换（约束内）→ 导出 PDF 打印发放
→ :assign 记录为作业 → 纸面作答 → 教师批改 → 成绩导入（06）
→ mastery 更新 → 画像刷新 → 下一次练习依据更新（闭环）
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 某生无任何薄弱项 | weak 桶让位，全 current+review；报告注明"该生无薄弱，练习以巩固为主" |
| 题池整体不足 | 降级链走完仍缺 → 明确缺题报告（kp、需要难度、建议数量），不生成凑数卷 |
| 班级 42 人 × 每生一套 PDF | zip 打包含 42 份 + 一份班级统一题清单；导出异步（file 模块） |
| 同一策略重复生成 | regenerate 换题（排除已 hold 曝光），不产生重复卷 |
| 教师手动换题越出难度带 | 允许（教师策略优先于算法），标记 manual_override=true |
| assign 前删除 plan | 未 assign 的 plan 及 soft-hold 一并释放 |

## 7. 验收标准（DoD）

- [ ] 配比：给定画像构造（3 弱项 + 2 断点 + 1 复习候选）→ 桶分配与策略一致
- [ ] 难度带映射表逐档测试；错题重现置顶；14 天去重生效
- [ ] 统一/个性化切分：统一题全班一致，个性化题因人而异
- [ ] 缺题报告：清空某 kp 题池后生成 → 返回明确缺题清单而非凑数卷
- [ ] 导出 PDF 42 份 < 60s，版式与原型一致（姓名页眉/分区/留白）
- [ ] assign → 曝光 committed → 作业成绩导入后该 plan 状态 closed（闭环联调）

## 8. 演进预留

- P2：策略模板保存与共享（教研组级）；统一题比例按章节预设
- P3：AI 变式题接入（题池不足时经教师确认启用变式扩充，走 12-ai 校验器）；学生端在线作答直接回流
