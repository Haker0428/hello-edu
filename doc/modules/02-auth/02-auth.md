# 02 · 认证授权（auth）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | 通用域 / P1 |
| 上游设计 | [架构文档 §4.1 / §6](../../架构与模块详细设计.md) |
| 前端原型 | [login.html](../../../design/prototype/login.html) |
| 依赖 | platform（school_user / teaching_assignment 数据） |
| 被依赖 | 全部模块（中间件层） |

## 1. 模块定位与边界

**职责**：登录与令牌（JWT）、RBAC 角色权限、班级级资源权限（任课关系）、审计日志。

**明确不做**：
- 不做组织数据管理（角色归属存 platform，本模块只做**判定**）
- P1 不做 SSO / 家长端账号 / 学生端账号（学生无账号，P3 学生端再引入）

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/auth/login | 登录，返回 access + refresh |
| POST | /api/auth/refresh | 刷新令牌（旋转式） |
| POST | /api/auth/logout | 注销（refresh 入黑名单） |
| GET | /api/me | 当前用户 + 学校 + 可见班级 + 权限清单 |
| PATCH | /api/users/{id}/password | 改密（需旧密码） |

**登录响应**：

```json
{
  "data": {
    "access_token": "eyJ...", "refresh_token": "eyJ...",
    "user": {"id": 9, "name": "王老师",
             "roles": ["subject_teacher"],
             "school": {"id": 1, "name": "实验中学"},
             "classes": [{"id": 3, "name": "初一(3)班", "subject": "数学"}]}
  }
}
```

## 3. 数据模型

```sql
CREATE TABLE refresh_token (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  token_hash VARCHAR(128) NOT NULL UNIQUE,   -- 只存哈希
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,                    -- 旋转时旧 token 置 revoked
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE login_attempt (                 -- 登录失败锁定依据
  account VARCHAR(128) PRIMARY KEY,
  fail_count INT DEFAULT 0,
  locked_until TIMESTAMPTZ
);

CREATE TABLE audit_log (                     -- 全站审计（auth 模块拥有中间件）
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT, actor_id BIGINT,
  action VARCHAR(64) NOT NULL,               -- 如 exam.score.commit
  resource VARCHAR(128),                     -- 如 exam:42
  detail JSONB,
  ip INET, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC);
```

## 4. 核心逻辑

### 4.1 令牌策略

| 项 | 值 |
| --- | --- |
| access_token 有效期 | 2 小时 |
| refresh_token 有效期 | 14 天，**旋转式**（每次刷新作废旧 refresh，旧 token 一次性） |
| JWT payload | `{sub, school_id, roles[], ver, exp}` |
| 签名算法 | HS256（单服务部署足够；拆分服务时换 RS256） |

### 4.2 权限模型：角色 × 资源级

权限判定分两层，**先角色后资源**：

```
authorize(user, action, resource):
  1. 角色层：roles 是否具备 action 的角色要求（下表）
  2. 资源层：action 涉及 class 资源时，校验 teaching_assignment（任课）或班主任身份
  3. 通过 → 放行；否则 403（返回缺失的权限名，便于前端引导）
```

**权限矩阵**：

| 能力 | school_admin | head_teacher | subject_teacher |
| --- | --- | --- | --- |
| 班级/名单/任课管理 | ✓ 本校 | ✗ | ✗ |
| 试卷接入、成绩导入 | ✓ 本校 | 本班 | **任教班级** |
| 热力图、学生画像 | ✓ 本校 | 本班 | 任教班级 |
| 练习生成、干预记录 | ✓ 本校 | 本班 | 任教班级 |
| 跨学科视图（班主任视角） | ✗ | ✓ | ✗ |
| 租户参数配置（阈值等） | ✓ | ✗ | ✗ |

多角色取并集（如班主任兼数学教师）。`GET /api/me` 返回展开后的班级可见清单，前端据此渲染班级选择器。

### 4.3 登录防护

- 密码哈希：argon2id
- 连续失败 5 次 → 账号锁 15 分钟（login_attempt）
- 审计：登录成功/失败、所有写操作、画像/成绩的批量导出均入 audit_log

### 4.4 中间件链（Django）

```
请求 → JWT 校验 → 租户注入（SET LOCAL app.school_id）→ RBAC 装饰器 → 资源级校验 → 业务
                                  ↘ 审计中间件异步写 audit_log（写操作）
```

## 5. 关键流程

```
login → 颁发双 token → 前端带 access 访问
  → access 过期(401) → /auth/refresh（旋转）→ 重放原请求
  → refresh 过期 → 回登录页
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 任课关系变更（中途接手班级） | 立即生效（每次请求实时查 teaching_assignment，不进 JWT 缓存） |
| 教师查看非任教班级学生 | 403 + 明确错误信息（不静默降级） |
| 旋转 refresh 被重放 | 旧 token 已 revoked → 撤销该用户全部 refresh（疑似泄露）+ 审计告警 |
| 班主任查跨学科视图 | 只读聚合接口，不能看别科逐题明细（最小权限） |

## 7. 验收标准（DoD）

- [ ] 权限矩阵逐格集成测试（3 角色 × 主要 action 全覆盖）
- [ ] 非任教班级的资源访问全部 403（含 guessed-id 越权探测）
- [ ] token 过期 → refresh 旋转 → 旧 refresh 重放被拒
- [ ] 连续 5 次错误密码锁定 15 分钟
- [ ] 写操作 100% 产生 audit_log 记录

## 8. 演进预留

- P2：家长端只读账号（新角色 + 学生授权关系表）
- P3：学生端账号（app 作答回流的身份源）；SSO 对接学校统一身份
