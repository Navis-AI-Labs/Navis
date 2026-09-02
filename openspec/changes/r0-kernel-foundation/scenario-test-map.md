# r0-kernel-foundation — 已实现范围的场景↔测试映射（供人工检验）

> 本文件是变更单的辅助核对材料，非 OpenSpec 正式 artifact。
> 对照基准：`openspec/changes/r0-kernel-foundation/specs/domain-object-model/spec.md`
> 权威依据：Navis-Research `concepts/proposals/20260820_Navis_项目交付可持续性内核与可生成Schema层设计提案.md`（accepted；YAML 注明"概念性示意，非实现规范。最终实现以 domain package 代码为准"）。

## 本次交付（第 1、2、3 组 + 4.3 + 第 5 组）

| 任务 | 产物                                                                                                                                                                                                                                                                                         | 验证                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1.1  | `docs/adr/ADR-0005-domain-kernel-storage-abstraction.md`                                                                                                                                                                                                                                     | ADR 已立案（Proposed）                                                               |
| 2.1  | `packages/domain`（tsconfig/package.json/exports）                                                                                                                                                                                                                                           | `pnpm validate` 全绿                                                                 |
| 2.2  | `packages/infrastructure`（package.json：`@navis/domain` + `postgres` 3.4.7；tsconfig 对）                                                                                                                                                                                                   | `pnpm validate` 全绿                                                                 |
| 2.3  | 根 `dependency-cruiser.config.cjs` 已含 infrastructure 单元（ADR-0001 规则）                                                                                                                                                                                                                 | `pnpm boundaries` 80+ 模块 0 违规                                                    |
| 3.1  | `src/schema/ids.ts`（UUIDv7 RFC 9562：闭包工厂、时钟回拨钳制、同毫秒单调计数、4096 溢出借位、DataView 数学布局、variant 位校验）                                                                                                                                                             | `test/ids.test.ts` 10 用例                                                           |
| 3.2  | `src/schema/*.ts` 11 个自包含模型文件＋`text.ts`/`time.ts` 共享原语（一文件一概念，字段集照权威基线转写）〔更新：55 用例——字段等值＋10 枚举 set-equality＋正例构造矩阵＋tombstone 守卫〕                                                                                                     | `test/schema-baseline.test.ts` 41 用例                                               |
| 3.3  | `src/schema/asset.ts` 生命周期表＋purge 常数＋`src/errors/schema.ts` 注册表（11 合法转换＋purge 双条件门＋token→URN 单源）                                                                                                                                                                   | `test/asset-lifecycle.test.ts` 29 用例                                               |
| 4.3  | `src/ports/event-store.ts`（事件信封 schema＋EventStore 端口）＋`src/ports/clock.ts`（时间端口，零驱动类型）                                                                                                                                                                                 | `test/event-envelope.test.ts` 3 用例＋`test/clock.test.ts` 1 用例                    |
| 4.1  | `src/state/`（StateEvent 信封 schema＋EventHistory 追加式账本＋canonical JSON/deep-freeze 助手；无 update/delete API，篡改探针守卫）〔守卫：schema 拒绝先于任何变更、seq 缺口拒收、深冻结嵌套写入 throw、无库单元 12 用例〕                                                                  | `test/state-events.test.ts` 12 用例                                                  |
| 5.1  | `src/persistence/in-memory/in-memory-event-store.ts`〔更新：端口一致性套件 12 场景——追加/冲突/跳号全有或全无/隔离/快照多版本＋首写赢/空批/信封归属/游标归一化；InMemory 与 Postgres 共跑同一组场景〕                                                                                         | `test/in-memory-event-store.test.ts` 5 用例                                          |
| 5.2  | `src/persistence/postgres/postgres-event-store.ts`＋`migrations/001_events.sql`〔更新：六层 L1–L5＋门禁索引墓碑过滤＋资产归属 CHECK＋INSERT-only 触发器；集成套件带 DATABASE_URL 真库往返（CI service 容器注入）；fake-wire 单元套件无库覆盖全部分支 19 用例，含 F4 回归守卫 18×N 参数断言〕 | 集成套件在 DATABASE_URL 存在时运行，缺席自动 skip；SQL 随 `pnpm validate` 结构门通过 |
| 5.3  | `src/persistence/postgres/connection.ts`〔更新：连接工厂＋POOL 命名常数＋目录扫描迁移＋sha256 checksum 守卫——漂移拒绝/重跑 no-op/legacy NULL 收编；见 postgres-wire-unit 迁移四分支＋真库篡改实证〕                                                                                          | `test/connection.test.ts` 2 用例                                                     |
| 6.1  | `pnpm validate` 七道门〔更新：双模式全绿——带 DATABASE_URL 147/147；无库 146＋1 skip，覆盖率均满格〕                                                                                                                                                                                          | 147/147 带真库；146＋1 skip 无库                                                     |
| 6.3  | `docs/architecture.md` 区域表补 ADR-0005 行、激活状态段与目录树更新 infrastructure 为 active                                                                                                                                                                                                 | 文档与代码一致                                                                       |

## domain-object-model spec 场景覆盖表

### Requirement: 字段基线（8 核心类型＋系统类型）

| Spec 场景                                                                                                                                                                 | 测试                                                                                                                                                                                             | 说明                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| unknown extra keys are rejected                                                                                                                                           | `schema-baseline.test.ts > no unknown extra keys`                                                                                                                                                | strictObject 拒绝未知键 |
| TaskSpace 字段恰为 id + 治理四件套 + work_id                                                                                                                              | `schema-baseline.test.ts > TaskSpace fields`                                                                                                                                                     | 权威 YAML 等值断言      |
| 各类型字段集（purpose/statement/applicability/dispatched_at/version/attempt_no/criteria_snapshot/evidence_refs/captured_at/state_version/execution_refs/project_id 归属） | `schema-baseline.test.ts > XX fields`（9 个）＋字段规则负例（project-scope Asset 无 project_id、Hold 无 statement、Acceptance 无 criteria_snapshot、Delivery confirmed 无责任人、fowler 跨字段） | 与权威 YAML 等值        |
| 枚举集（status/kind/scope/lifecycle/severity 等）                                                                                                                         | `schema-baseline.test.ts > XX is exactly the N-value baseline`（8 个）                                                                                                                           | 排序后等值断言          |
| 治理四件套：boolean deleted/ext 禁止、quartet 必在（Equip/Checkpoint 豁免）、updated_* 仅重放可写                                                                         | `schema-baseline.test.ts > field conventions guard`（含 replay-only cache 子断言）                                                                                                               | 全类型扫描断言          |
| Participant 是唯一 actor 身份                                                                                                                                             | Participant refs 出现在 Acceptance.actor、Hold.registered_by、Equip.participant_id、intervention_sessions[].participant_id                                                                       | 引用形状层              |

### Requirement: 生命周期转换表（T13 移植）

| Spec 场景                         | 测试                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| 11 条合法对逐条通过               | `asset-lifecycle.test.ts > legal transitions (T13 port)` it.each 10 对 + purge 门            |
| 6 条非法对逐条拒绝                | `asset-lifecycle.test.ts > illegal transitions (T13 port)` it.each 10 对                     |
| rejected 终态                     | `rejected→active/rejected→archived/rejected→candidate` 拒绝                                  |
| archived 状态仅经双条件门可 purge | `purge double-condition gate` 4 用例（100d+确认/200d 无确认/200d+确认通过/非 archived 拒绝） |
| contested 不可达                  | `contested is reserved` 全状态扫描                                                           |
| resubmission 不是生命周期转换     | rejected 终态测试＋设计注记（新候选 provenance 引用被拒前驱）                                |

### Requirement: rationale 条件必填

| Spec 场景                                        | 测试                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| rejected 无 rationale 拒绝（错误指向 rationale） | `acceptance rationale rule > rejects a rejected verdict without rationale` |
| conditional 空 rationale 拒绝                    | `rejects a conditional verdict with empty rationale`                       |
| accepted 可无 rationale                          | `accepts an accepted verdict with null rationale`                          |
| 判断史账本（两条独立判断共存）                   | `keeps two independent judgments append-only`                              |

## persistence-ports spec 场景覆盖表（4.3＋第 5 组）

| Spec 场景                                             | 测试/证据                                                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| port has no driver types                              | `packages/domain/src/ports/` 零 driver import（boundaries 门＋编译期 satisfies：InMemoryEventStore/PostgresEventStore 实现 EventStore） |
| infrastructure implements the port                    | `in-memory-event-store.test.ts`＋`postgres-event-store.ts implements EventStore`（编译期）                                              |
| connection via environment configuration              | `connection.test.ts > applies the pool options`＋集成套件（DATABASE_URL 存在时 connect+migrate）                                        |
| schema migration is plain SQL and idempotent          | `runMigrations` 以 schema_migrations 幂等记账；集成套件二次运行 no-op                                                                   |
| event table enforces append-only at the storage layer | `001_events.sql` INSERT-only 触发器；集成套件 UPDATE/DELETE 断言 rejects                                                                |
| optimistic concurrency enforced at the storage layer  | UNIQUE(project_id, seq)；内存套件冲突用例＋集成套件同预期版本二写一败                                                                   |
| delivery-gate query uses partial indexes              | `001_events.sql` idx_holds_gate＋idx_effect_ledger_unknown 两个 partial index；门控 SQL 由内核任务 4.2 消费                             |
| command idempotency is enforced at the storage layer  | command_inbox UNIQUE(project_id, idempotency_key)；写侧由内核任务 4.2 消费                                                              |
| domain tests run without a database                   | `pnpm validate` 全量测试在无 DATABASE_URL 环境通过                                                                                      |
| integration tests skip cleanly without a database     | `describe.skip` 门控：无 DATABASE_URL 时集成套件报告 skipped（非 failed）                                                               |

## 与权威的偏差记录

| 偏差                                                        | 权威处理                                 | 本实现处理                                                                |
| ----------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| Actor 引用一律 Participant ref（Equip.participant_id 等处） | 权威基线的 system types 约定             | 全部以 uuid 字符串引用实现                                                |
| `valid_from`/`valid_to`                                     | 基线约定：R0 预留默认 null，R2+ 启用     | schema 保留 optional，不读不写行为                                        |
| `quality_signals`                                           | 权威基线：**运行时属性，非 Schema 字段** | **不进 schema**；仅在 workrun.ts 头注释记录约定                           |
| intervention_sessions 内部结构                              | 权威只说 array，未固化                   | 实现约定：participant_id/mode/started_at/ended_at（见 workrun.ts 头注释） |

## 尚未实现（后续变更单）

内核操作层（4.1/4.2：错误注册表、可重放投影、动作门控）、WorkRun 状态机、向量时钟、Effect Ledger 行为层、快照策略、schema 层 Interfaces/Link Types/Type Registry、submission_criteria 框架——均已在 proposal.md/design.md/tasks.md 声明为后续变更。端口与适配器（4.3/5.x）已随本次交付完成。

## 第 4 轮加固场景（字段治理 + 适配器自洽）

| 缺陷     | 场景                                                                                 | 测试/实证                                                                                                        |
| -------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| S1–S5    | SQL 字段错位/缺列/裸状态列/无长度约束                                                | schema-baseline 字段等值断言 + 真库结构验证                                                                      |
| F4       | 批量 INSERT 18 列 17 值（每 append 必炸）                                            | `postgres-wire-unit.test.ts > one parameter per column per row`（18×N 参数断言，永久回归守卫）                   |
| F5/F6    | 空批语法错误 / 批内跳号写穿                                                          | conformance 空批 no-op + 跳号全有或全无（双适配器共跑）                                                          |
| C2       | 批内失败前缀已写入                                                                   | 同上 all-or-nothing 场景                                                                                         |
| F8       | 快照语义分叉（last-write-wins vs 多版本）                                            | conformance `keeps snapshot history and loads the max state_version`                                             |
| G1       | 信封 project_id 与 append 目标错位                                                   | conformance `rejects an envelope whose project_id differs`（双适配器）                                           |
| X1       | 并发竞争 unique-violation 漏出原始错误                                               | `postgres-wire-unit.test.ts > rethrows a concurrent-commit unique violation as version-conflict`（cause 挂根因） |
| F-1      | L2 缺 `delivery_attempts` 表与 `UNIQUE(delivery_id, attempt_no)`（DEC-0009 §6 承诺） | `postgres-wire-unit.test.ts > L2 carries the per-delivery attempt lineage table`（表形+约束+墓碑列断言）         |
| F-7      | holds `source_event_ids` 列数组与 `hold_source_events` 关系表双存储                  | `postgres-wire-unit.test.ts > holds store source-event lineage only in the relation table`（单存储断言）         |
| F-2      | zod 层缺基线 default（confirmation_status/blocks_delivery）                          | `schema-baseline.test.ts` 构造矩阵省略字段走 default 断言成功                                                    |
| A1       | 内存适配器存调用者引用（append 后可改写——Postgres 触发器做不到的事）                 | 适配器修复：append/快照存 structuredClone + deepFreeze 副本；immutability 契约奇偶性恢复                         |
| X2       | 毒快照（state 无 seq 游标）静默入库                                                  | 双适配器写侧门禁 + conformance 负例                                                                              |
| X3       | 同版本重写语义相反（覆盖 vs DO NOTHING）                                             | conformance 首写赢断言（对齐 PG ON CONFLICT）                                                                    |
| X4       | 负/小数游标静默空查                                                                  | conformance 游标归一化（floor 保守截断）+ wire 单元绑定断言                                                      |
| X5       | jsonb null 静默降级 `{}`                                                             | `rejects a legacy snapshot row whose state arrived null`（存储契约违约显式抛出）                                 |
| 墓碑     | 门禁索引不看 deleted_at；墓碑早于出生                                                | 真库 DO-block 三连实证（hold 出闸门/槽位让出/时序 CHECK 拒绝）                                                   |
| 归属     | assets.project_id NOT NULL 与 org-scope 裁定矛盾                                     | 真库双分支（org 免填接受 / project 缺失拒绝）+ zod refine 同规则                                                 |
| checksum | 已应用迁移被静默改动                                                                 | 真库篡改实证 + 单元四分支（fresh/match/drift/legacy-adopt）                                                      |
