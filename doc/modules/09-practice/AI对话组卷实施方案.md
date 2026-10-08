# AI 对话式组卷（两阶段受控生成）实施方案

> 参考来源：智卷工坊（[DreZeo/examcraft-ai](https://github.com/DreZeo/examcraft-ai)，**MIT 协议，可直接读源码借鉴**）实际运行体验
> 截图解构：对话输入需求 → AI 回「方案」待确认（题型配比/分值/难度/覆盖范围）→ 确认后以「操作清单」执行（重命名试卷/新增 N 题）→ 题目进排版编辑器（字体/字号/行距/页面/页眉页脚）→ 教师视图/学生预览双视图
> 归属：09-practice（组卷交互与产物）+ 12-ai（生成与校验能力）
> 日期：2026-09-30

---

## 〇、先解构：这套体验到底由哪几个机制组成

| # | 机制 | 截图中的体现 | 为什么值得学 |
| --- | --- | --- | --- |
| M1 | **两阶段生成** | AI 先答方案（20 单选+5 判断/每题 1 分/中等难度）并询问"是否调整"，确认后才生成 | 25 题的生成成本和纠错成本高，先确认 1KB 的方案比生成后返工便宜百倍 |
| M2 | **操作指令集** | "AI 建议"里是结构化操作列表：重命名试卷、新增 25 道题（逐题可见） | LLM 输出被约束成**可校验、可逐条确认、可回滚的操作**，而不是一段自由文本 |
| M3 | **对话即上下文** | 同一会话里继续说"把判断题改成 10 道"就能增量调整 | 会话状态 = 当前卷的结构摘要，增量修改不用从头再来 |
| M4 | **排版所见即所得** | 微软雅黑/小四/1.5 倍行距/A4 纵向/窄边距/页眉页脚 1/3 | 预览分页 = 打印分页，教师信任的来源（已列入 09 参考吸收建议 §2.5） |
| M5 | **双视图** | 教师视图 / 学生预览 一键切换 | 同一份数据两种呈现（已列入 09 参考吸收建议 §2.1，我们扩展为批改版） |

本方案聚焦 **M1-M3（对话式两阶段组卷）**——M4/M5 已在《[参考吸收建议](./参考吸收建议.md)》覆盖，不重复。

---

## 一、定位决策：它在我们产品里是什么（先想清楚再动手）

我们的产品原则（需求 4.3、架构不变量 4）：**题库优先，AI 变式辅助；LLM 永不直写状态**。智卷工坊的"AI 自由出整卷"不能照搬为默认路径——AI 凭空生成的题没有经过真实考试检验，答案与知识点标注质量不可控，直接进练习闭环会污染画像。

**三层定位（递进交付）**：

| 层 | 能力 | 题目来源 | 进入练习闭环的条件 | 时机 |
| --- | --- | --- | --- | --- |
| L0 | 细目表组卷（AI 只出**方案**） | 纯题库选题 | 题库题天然合规 | **P1.5**（本方案 Phase A） |
| L1 | 题库不足时 AI 补题（受控变式） | 题库母题 + 变式 | 过答案校验器 + 教师确认 | P2.5（本方案 Phase D） |
| L2 | AI 主导生成整卷（教师显式发起） | LLM 生成 | 逐题确认后才入题库 draft | P3（复用本方案全部机制） |

> 关键结论：**交互范式（两阶段 + 操作指令集）三层通用，先在 L0 落地**——AI 出细目表方案（题型配比 × 知识点覆盖 × 难度阶梯），选题仍走题库。这样 P1.5 就能获得智卷工坊的体验，而不违反"题库优先"。

## 二、总体设计

### 2.1 交互流（对标截图）

```
教师：「一元一次方程，25 题，中等难度」
  ↓ Phase 1（秒级）
AI 返回【方案卡片】：
  结构：18 单选 + 4 填空 + 3 解答 ｜ 每题分值/总分 ｜ 难度阶梯(易6:中13:难6)
  知识点覆盖：移项×6 去分母×6 去括号×5 综合求解×5 应用×3   ← 用我们的图谱，不是它的自由发挥
  [调整方案]（继续对话） [确认，开始选题]
  ↓ Phase 2（题库选题，秒级；L1/L2 才涉及生成，异步）
【操作清单】：重命名练习卷 / 新增 25 题（逐题可见，含 kp 标签）/ 从题库排除建议
  [逐条确认/调整] → 生成 practice_plan → 复用现有：预览→导出→assign→成绩回流
```

### 2.2 API 设计（新增 `ai_paper` 会话域，挂在 practice 下）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/ai-paper/sessions | 创建会话 `{class_id, curriculum_id}` |
| POST | /api/ai-paper/sessions/{id}/messages | 发消息 `{text}` → 返回方案或操作清单（MVP 非流式；P2 升 SSE） |
| POST | /api/ai-paper/sessions/{id}/plan:confirm | 确认方案 → 触发 Phase 2 |
| POST | /api/ai-paper/sessions/{id}/apply | 应用操作清单 → 生成 practice_plan（draft） |
| GET | /api/ai-paper/sessions/{id} | 会话历史与当前卷状态 |

### 2.3 数据模型（增量，三张表）

```sql
CREATE TABLE ai_paper_session (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  teacher_id BIGINT NOT NULL,
  curriculum_id BIGINT NOT NULL,
  plan JSONB,                  -- 当前方案（Phase 1 产物，确认后冻结）
  paper_state JSONB,           -- 当前卷结构摘要（题数/结构/kp 覆盖），对话上下文用
  practice_plan_id BIGINT,     -- apply 后关联
  status VARCHAR(12) DEFAULT 'chatting',   -- chatting | planned | applied
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ai_paper_message (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES ai_paper_session,
  role VARCHAR(8) NOT NULL,        -- user | assistant
  content TEXT NOT NULL,           -- 展示文本
  payload JSONB,                   -- 结构化产物：plan / operations（渲染卡片用）
  created_at TIMESTAMPTZ DEFAULT now()
);
-- practice_plan 增加 origin 字段：'manual' | 'ai_chat'（strategy 快照里记录方案）
```

### 2.4 两个核心 Schema（prompt 约束输出，走 12-ai 四层校验链）

**Plan Schema（Phase 1 产物 = 方案卡片）**：

```json
{
  "title": "一元一次方程 · 随堂练习",
  "total_score": 25,
  "structure": [
    {"type": "single_choice", "count": 18, "score_each": 1},
    {"type": "fill", "count": 4, "score_each": 1},
    {"type": "solve", "count": 3, "score_each": 1}
  ],
  "difficulty_ladder": {"easy": 6, "medium": 13, "hard": 6},
  "kp_coverage": [{"kp_id": 1206, "count": 6}, {"kp_id": 1207, "count": 6}]
}
```

领域策略校验（L3）：`kp_id` 必须在该班教材图谱候选内；`Σcount == Σstructure.count`；kp_coverage 与教学范围一致。

**Operations Schema（Phase 2 产物 = 操作指令集）**：

```json
{"operations": [
  {"op": "rename_paper", "to": "一元一次方程 · 随堂练习"},
  {"op": "add_questions", "questions": [
    {"seq": 1, "type": "single_choice", "stem": "…", "options": ["A…","B…"],
     "answer": "B", "kp_ids": [1206], "difficulty": 2, "source": "bank|ai_variant|ai_generated"}
  ]},
  {"op": "remove_question", "seq": 7}
]}
```

> L0 阶段 `source` 恒为 `bank`（AI 只是从题库**选**，不出题）——操作清单此时退化为"选题结果预览"，机制完全一致。L1/L2 才出现生成类题目。

## 三、与现有模块的衔接（不新造闭环）

```
ai_paper 会话 ──apply──▶ practice_plan（origin=ai_chat, draft）
                          ↓ 复用 09 现有全部下游
                     预览（sheet 渲染）→ 导出（13-file，教师版/学生版）→ assign → 成绩回流 → mastery
L1/L2 生成的题 ──▶ question(status=draft, source=ai_variant|ai_generated)
                   门槛：答案校验器（sympy/数值）+ kp 标注（图谱候选）+ 教师逐题确认
                   未确认的 AI 题：只存在于草稿卷，不进 :select 检索，不进画像
```

| 涉及模块 | 增量 |
| --- | --- |
| 12-ai | 新增 `draft_paper_plan()` 与 `compose_operations()` 两个能力（复用 Provider/校验链/prompt 集中管理） |
| 09-practice | `practice_plan.origin` 字段；apply 入口；方案卡片与操作清单组件 |
| 04-question | `source` 枚举扩展 `ai_generated`；draft 题的确认队列（复用 05 的置信度分流交互） |
| 前端 | 右侧 Drawer 聊天面板（会话/消息/卡片三组件）+ 方案卡 + 操作清单卡；卷预览复用 practice 的 sheet |

## 四、实施路线（四阶段，每阶段独立交付价值）

| 阶段 | 内容 | 工作量 | 交付价值 |
| --- | --- | --- | --- |
| **A · 方案生成器** | 不做聊天：练习生成页加「AI 建议方案」→ Plan Schema → 方案卡（细目表）→ 教师调整 → 走现有题库选题 | 后端 3-4 天 + 前端 2-3 天 | P1.5 即获得"AI 组卷"心智，题库零风险 |
| **B · 对话外壳** | 会话表 + 消息 API + 聊天面板；多轮调整方案（"判断题改成 10 道"） | 3-4 天 | 截图体验的主体 |
| **C · 操作指令集** | Operations Schema + apply + 逐条确认 UI + paper_state 增量上下文 | 5-7 天 | 增量改卷、逐题可控 |
| **D · 生成与校验闭环**（L1/L2） | AI 补题/整卷生成 + 答案校验器 + draft 题确认队列 + 入库 | 1.5-2 周（校验器是大头） | 题池不足的自愈能力，P2.5/P3 |

单人全职估算：A+B+C 约 3 周；D 再 2 周。**A 可以立即排入 P1.5，与 05 的解析分流改造并行。**

## 五、关键实现细节

1. **上下文管理**：每次请求只带「最近 6 轮消息 + `paper_state` 结构摘要（~500 token）」，不回传全卷题目——控制成本与注意力。
2. **流式与否**：Phase 1 方案生成 3-8s，MVP 用非流式 + 骨架屏即可；教师反馈在意"可控"多于"打字机效果"。SSE 留到 P2（Django 同步视图透传即可，不必上 channels）。
3. **apply 幂等**：`session.status=applied` 后拒绝重复 apply；操作按 seq 幂等执行。
4. **方案与策略模板的关系**：AI 方案 = 初始值，教师可在方案卡上直接改数字（配比/难度），确认时以**教师改后的为准**写回 strategy 快照——「教师策略优先于算法」在交互层的落点。
5. **读源码的姿势**（MIT 红利）：重点看它的 Zod schema 定义（题目/方案的结构约束怎么写）、两阶段状态机、JSON 容错提取——这三块可以直接对照翻译成我们的 pydantic + Django 实现；借鉴代码片段时保留其版权声明。

## 六、风险与边界

| 风险 | 对策 |
| --- | --- |
| AI 方案的 kp_coverage 幻觉 | 图谱候选约束 + L3 校验（候选外一律丢弃），复用 05 标注的成熟做法 |
| L2 生成题答案错误 | 答案校验器（sympy/数值代入）一票否决；过不了的题不进确认队列 |
| 教师绕过确认直接 apply | 不提供该路径——操作清单确认是架构不变量 4 的 UI 表达 |
| 对话式入口弱化题库心智 | 首页入口命名「AI 组卷顾问」；方案卡明示"从题库选题"，生成类能力到 L1 才解锁 |
| 成本 | 会话级 token 预算；同 session 缓存 paper_state，避免全量重生成 |

## 七、验收标准（DoD）

- [ ] Phase A：给定"25 题中等难度"→ 方案卡结构完整、kp 覆盖在教学范围内、教师可改并生效
- [ ] Phase B：多轮对话增量调整方案，paper_state 一致，无全量重置
- [ ] Phase C：操作清单逐条确认/拒绝；apply 幂等；生成的 practice_plan 走通导出→assign→回流
- [ ] Phase D：构造答案错误的生成题 100% 被校验器拦截；draft 题未确认不出现在 :select
- [ ] 全程：AI 产物均为草稿，无任何直接写题库/画像路径（不变量 4 审计）
