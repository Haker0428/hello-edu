# 01 · 基础数据与租户（platform）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | 通用域 / P1 |
| 上游设计 | [架构文档 §4.1](../../架构与模块详细设计.md) |
| 前端原型 | 管理后台（原型暂未包含，布局参考通用后台） |
| 依赖 | auth（角色体系） |
| 被依赖 | 全部模块（school_id 租户键的来源） |

## 1. 模块定位与边界

**职责**：学校、班级、学生、任课关系的组织数据管理；教材绑定；多租户隔离的落地层。

**明确不做**：
- 不做知识点管理（绑定教材后由 knowledge 模块展开）
- 不做权限判定（本模块提供数据，auth 模块做判定）
- 不做成绩与画像（只维护"人"和"组织"）

## 2. 对外接口

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | /api/schools | 创建学校（平台运营操作） | platform_admin |
| GET | /api/schools/{sid} | 学校详情 | 本校 |
| POST | /api/schools/{sid}/classes | 创建班级 | school_admin |
| GET | /api/classes | 当前用户可见班级列表（按任课关系过滤） | 登录 |
| GET | /api/classes/{id} | 班级详情（学生数/任课教师/教材） | 本班权限 |
| PATCH | /api/classes/{id} | 修改班名/班主任 | school_admin |
| PUT | /api/classes/{id}/curriculum | 绑定教材（触发知识点树可见） | school_admin |
| POST | /api/classes/{id}/students:import | Excel 名单导入（校验+预览+确认三段式） | school_admin |
| POST | /api/classes/{id}/students | 新增单个学生 | school_admin |
| PATCH | /api/students/{id} | 修改姓名/学号 | school_admin |
| POST | /api/students/{id}:transfer | 转班（记录流转日志） | school_admin |
| POST | /api/students/{id}:deactivate | 转学/离校（软删除） | school_admin |
| PUT | /api/classes/{id}/teaching-assignments | 设置任课教师 | school_admin |

**名单导入响应结构（预览阶段）**：

```json
{
  "data": {
    "rows": [
      {"row_no": 1, "student_no": "20253101", "name": "李想", "match": "exact", "student_id": 101},
      {"row_no": 2, "student_no": "", "name": "王 雪", "match": "name_trim", "suggest_student_id": 102},
      {"row_no": 3, "student_no": "20240338", "name": "?", "match": "none", "candidates": []}
    ],
    "summary": {"exact": 38, "name_trim": 3, "new": 2, "conflict": 1}
  }
}
```

## 3. 数据模型

```sql
CREATE TABLE school (
  id         BIGSERIAL PRIMARY KEY,
  name       VARCHAR(128) NOT NULL,
  code       VARCHAR(32) UNIQUE,          -- 学校编码（SaaS 形态用）
  settings   JSONB DEFAULT '{}',          -- 租户级参数：掌握度阈值、策略模板、半衰期等（mastery 读取）
  status     VARCHAR(8) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE app_user (
  id            BIGSERIAL PRIMARY KEY,
  name          VARCHAR(64) NOT NULL,
  account       VARCHAR(128) UNIQUE NOT NULL,   -- 工号或手机号
  password_hash VARCHAR(128) NOT NULL,
  is_platform_admin BOOLEAN DEFAULT false
);

CREATE TABLE school_user (                 -- 用户 ↔ 学校 ↔ 角色（多角色取并集）
  school_id BIGINT REFERENCES school,
  user_id   BIGINT REFERENCES app_user,
  role      VARCHAR(16) NOT NULL,          -- school_admin | head_teacher | subject_teacher
  PRIMARY KEY (school_id, user_id, role)
);

CREATE TABLE class_room (
  id                BIGSERIAL PRIMARY KEY,
  school_id         BIGINT NOT NULL REFERENCES school,
  name              VARCHAR(64) NOT NULL,  -- 初一(3)班
  grade             VARCHAR(16) NOT NULL,
  academic_term_id  BIGINT REFERENCES academic_term,
  head_teacher_id   BIGINT REFERENCES app_user,
  curriculum_id     BIGINT REFERENCES curriculum,  -- 绑定教材
  status            VARCHAR(8) DEFAULT 'active',
  UNIQUE (school_id, name, academic_term_id)
);

CREATE TABLE student (
  id         BIGSERIAL PRIMARY KEY,
  school_id  BIGINT NOT NULL,
  name       VARCHAR(32) NOT NULL,
  student_no VARCHAR(32),                  -- 校内唯一，允许为空（幼儿园/低年级场景）
  class_id   BIGINT REFERENCES class_room,
  status     VARCHAR(12) DEFAULT 'active', -- active | transferred | graduated | left
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (school_id, student_no)
);

CREATE TABLE teaching_assignment (          -- 任课关系：auth 做班级级权限判定的数据源
  teacher_id BIGINT REFERENCES app_user,
  class_id   BIGINT REFERENCES class_room,
  subject    VARCHAR(32) NOT NULL,
  PRIMARY KEY (teacher_id, class_id, subject)
);

CREATE TABLE academic_term (id BIGSERIAL PRIMARY KEY, name VARCHAR(32), start_date DATE, end_date DATE);
CREATE TABLE textbook (id BIGSERIAL PRIMARY KEY, name VARCHAR(128), publisher VARCHAR(64), edition VARCHAR(32));
CREATE TABLE curriculum (id BIGSERIAL PRIMARY KEY, subject VARCHAR(32), textbook_id BIGINT REFERENCES textbook,
  grade VARCHAR(16), status VARCHAR(8) DEFAULT 'active');   -- draft | active | deprecated

CREATE TABLE student_transfer_log (         -- 转班/学号变更日志（画像跨班携带的追溯依据）
  id BIGSERIAL PRIMARY KEY, student_id BIGINT, from_class BIGINT, to_class BIGINT,
  changed_fields JSONB, operated_by BIGINT, created_at TIMESTAMPTZ DEFAULT now()
);
```

## 4. 核心逻辑

### 4.1 多租户隔离（RLS）

```sql
ALTER TABLE student ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON student
  USING (school_id = current_setting('app.school_id')::BIGINT);
-- 其余业务表同模式
```

Django 中间件在**每个事务开始**时执行 `SET LOCAL app.school_id = :sid`（从 JWT 取）。应用层 ORM 过滤作为第二道保险（防 RLS 漏配）。

### 4.2 名单导入匹配算法

```
对 Excel 每行依次判定（短路）：
1. 学号精确匹配（本校）→ match=exact
2. 姓名去空格后匹配本班 → 唯一命中 match=name_trim（需确认），多命中 match=name_ambiguous（列候选）
3. 无匹配 → match=none，可选"新建"
冲突检测：同学号不同姓名 / 同班同名 → conflict，必须人工处理
```

### 4.3 学生生命周期

- **禁止物理删除**：转学/离校走 `status` 软删除；历史事件与画像保留（`student_answer_event` 锚定 student_id）。
- **转班**：更新 class_id + 写 `student_transfer_log`。
- **班级看板聚合口径（P1 决策）**：按学生**当前班级**聚合，转班学生历史数据随人进入新班视图；教师侧可接受，P2 若需"按事件发生时班级"统计再引入事件级班级快照。

### 4.4 教材绑定

`PUT /curriculum` 仅写入 `class_room.curriculum_id`；知识点树的展开与合并由 knowledge 模块读时完成（见 [03-knowledge §4.1]((.././03-knowledge.md/./03-knowledge.md.md))）。

## 5. 关键流程

```
建校(school_admin) → 建班 → 导入学生名单(校验/确认) → 设置任课关系 → 绑定教材
                                                            ↓
                                              knowledge 展开标准知识点树
                                                  （该班的热力图/标注候选随之可用）
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 学号为空且同名 | 匹配返回 name_ambiguous，强制人工选择 |
| 重复导入名单 | 按（学号/姓名）幂等，已存在跳过并报告 |
| 绑定的教材被下线 | curriculum.status=deprecated 时允许存量班级继续用，新绑定拦截 |
| 一个用户在多校有账号 | P1 不支持（account 全局唯一即一人一账号）；多校支持放 P2 |
| 班级未绑定教材 | 热力图/练习/试卷标注返回明确错误码 `E_CURRICULUM_NOT_BOUND` |

## 7. 验收标准（DoD）

- [ ] RLS 集成测试：A 校 token 查询任何 B 校资源返回空（覆盖 student/class/exam 全表）
- [ ] 名单导入：100 行含 5 类异常（空学号/重名/冲突/学号错/新学生）→ 校验报告逐行正确
- [ ] 学生软删除后：不出现在班级列表与看板，历史事件仍可查
- [ ] 绑定教材后 1 分钟内，知识点树接口可返回该教材标准层
- [ ] 转班后该生画像数据完整跟随

## 8. 演进预留

- P2：学期滚动（班级复制 + 学生升年级映射）；多校账号
- P2：`school.settings` 下发 mastery 参数（见 [07-mastery §7]((.././07-mastery.md/./07-mastery.md.md))）
- P3：组织层级（集团/学区）支持
