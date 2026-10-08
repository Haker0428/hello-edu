# 13 · 文件与导出（file）

| 属性 | 值 |
| --- | --- |
| 域 / Phase | 通用域 / P1 |
| 上游设计 | [架构文档 §4.12](../../架构与模块详细设计.md) |
| 前端原型 | 各页面的上传/导出按钮（score-import.html、practice.html） |
| 依赖 | auth（权限） |
| 被依赖 | ingestion（试卷原件/Excel）、practice（练习卷导出）、platform（名单模板） |

## 1. 模块定位与边界

**职责**：文件上传与对象存储、三类导出（练习卷 PDF/Word、成绩模板 Excel、画像报告 P2）。

**明确不做**：不做文档解析（ingestion 调 PyMuPDF 自己做）、P1 不做网盘式文件管理。

## 2. 对外接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/files | 上传（multipart），返回 file_id |
| GET | /api/files/{id} | 下载（带权限校验：本校区间） |
| GET | /api/exports/practice-plan/{id}?format=pdf | 练习卷导出（异步，返回任务号） |
| GET | /api/exports/{task_id} | 导出任务状态与下载地址 |

## 3. 数据模型

```sql
CREATE TABLE file_object (
  id         BIGSERIAL PRIMARY KEY,
  school_id  BIGINT NOT NULL,
  bucket     VARCHAR(32) NOT NULL,        -- paper | score | export | misc
  object_key VARCHAR(255) NOT NULL,       -- {school_id}/{yyyy}/{uuid}.{ext}
  mime       VARCHAR(64) NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256     VARCHAR(64) NOT NULL,        -- 完整性 + 去重
  created_by BIGINT, created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE export_task (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL,
  type VARCHAR(32) NOT NULL,              -- practice_pdf | practice_docx | template_xlsx
  ref_id BIGINT NOT NULL,                 -- practice_plan / exam 等
  status VARCHAR(12) DEFAULT 'queued',    -- queued | running | done | failed
  file_id BIGINT REFERENCES file_object,
  error TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
```

## 4. 核心逻辑

### 4.1 上传

```
类型白名单：pdf, docx, xlsx, png, jpg ｜ 大小 ≤ 20MB
存储：S3 兼容接口（SaaS）/ MinIO（私有化 docker-compose 内置）
sha256 重复检测：同校同哈希 → 复用 file_object（试卷重复上传场景）
预留：ClamAV 病毒扫描接口（P2 接入，先留 hook）
```

### 4.2 练习卷 PDF 渲染（WeasyPrint）

```
模板规格（与 practice.html 原型 sheet 一致）：
  A4 纵向；页眉：卷标题 + 班级 + 姓名 ____ + 日期 ____
  分区：第一部分 统一练习 / 第二部分 个性化练习（题号连续）
  每题：题号. 题干（1.5 倍行距）+ 答题留白（按题型：填空线/解答区高度 = 难度×行数）
  选择题：选项两列排布
  页脚：页码 / 共 N 页
整班导出：42 份单生 PDF → zip（含一份班级统一题清单.xlsx）
异步执行（Celery），完成通知（轮询 export_task）
```

### 4.3 Excel 模板生成

```
成绩模板（06 消费）：openpyxl 生成，表头锁样式、名单预填、附"缺考留空"说明行
名单模板（01 消费）：学号/姓名 两列 + 示例行
```

## 5. 关键流程

```
上传 → 校验（类型/大小）→ 对象存储 → file_object 落库 → 返回 file_id
导出 → export_task(queued) → Celery 渲染 → 存储 → done + 下载地址
```

## 6. 边界情况与错误处理

| 场景 | 处理 |
| --- | --- |
| 断点续传 | P1 不做（20MB 内直传足够）；大文件场景 P2 分片 |
| 导出渲染失败（题干含异常字符） | 任务 failed + 错误明细定位到题；支持重跑 |
| 下载越权 | file 归属校验（本校区间 + 角色），签发短时效下载 URL（5min） |
| 存储清理 | 试卷原件永久保留；导出产物 90 天生命周期（可重生成） |
| 未成年人数据导出 | 练习卷含姓名属正常教学用途；画像报告导出记审计日志 |

## 7. 验收标准（DoD）

- [ ] 上传：白名单外类型/超 20MB 拒绝并返回明确错误
- [ ] 42 份练习卷 zip 导出 < 60s，版式与原型一致（打印实测 A4 无截断）
- [ ] 下载 URL 5 分钟过期；跨校 file_id 访问 403
- [ ] 导出失败可重跑且错误定位到题

## 8. 演进预留

- P2：画像报告 PDF（家长会版/教研版）；ClamAV 接入；大文件分片上传
- P3：学生端作答界面的题目资源（图/公式渲染服务）
