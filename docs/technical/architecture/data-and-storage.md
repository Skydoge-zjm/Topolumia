# 数据权威来源与存储

## 数据归属

| 数据 | 当前存储与责任 |
| --- | --- |
| 账号、项目、成员、登录、项目投影 | 全局 collaboration SQLite；[CollaborationStore](../../../src/services/platform/collaboration-store.ts) |
| 节点与组核心、块、对象/块版本、资产元数据、候选、读取回执、任务 | 同库按 project_id 隔离的研究表；[ResearchRepository](../../../src/services/research/objects/repository.ts) |
| 纪要、周期活动及其版本 | 同库 research_documents / versions；[NotebookStore](../../../src/services/research/notebook-store.ts) |
| 科研历程 | 同库项目化历史；[ResearchHistoryStore](../../../src/services/research/history/history-store.ts) |
| Agent 会话 | 每项目 agent-sessions/history.sqlite；[AgentHistoryStore](../../../src/services/agents/agent-history-store.ts) |
| 科研文件字节及派生预览 | 项目数据目录 research-assets；[资产服务](../../../src/services/research/assets/asset-service.ts) |
| 实验记录块、run 与材料对应 | 实验记录块的独立记录集合、块/集合版本和材料引用；连续事件、运行目录、索引、水位、快照与附件由记录接收表维护，静态导入的富事件索引与曲线索引均可从归档原件重建 |
| 会话图片与原生 imageView 快照 | history.sqlite 同级 attachments；[会话媒体](../../../src/services/agents/agent-attachment-service.ts) |
| 项目设置、原生 Agent 配置 | settings.json、agent-config；[项目装配](../../../src/application/project-runtime.ts) 决定路径 |

[app-paths.ts](../../../src/lib/app-paths.ts)在所有平台统一使用用户主目录下的 .topolumia，独立于源码和安装目录。全局配置为 ~/.topolumia/topolumia.config.json，账户数据库及每项目资产/设置/会话放 data，默认科研工作区放 workspaces/<projectId>，缓存放 cache。前后端共用配置解析，TOPOLUMIA_CONFIG 仅作为显式实例覆盖；不再根据 AppData、XDG 或 Application Support 自动分散应用数据。

Python 记录读取器在所在主机使用同一根下 data/record-readers 保存私有凭据、依赖和队列；测试或受控部署可显式覆盖其数据位置。用户选择的现有本机或 SSH 科研目录保持原位置，应用默认工作区与其分别表达。


## 正式对象与投影

正式节点核心和内容块在研究对象表中；拓扑是逻辑关系与对象摘要的投影，不是第二份可独立修改的正文。变更提交通过同一服务协调对象、关系、投影和历史。

正式节点详情和概览按 owner 读取材料，关系与仅节点搜索读取对象元数据和拓扑，不加载无关正文。需要完整变更模拟的候选和写入仍使用完整快照。结构化读取被字符预算截断时标记 coverage 不完整，后续范围和读取回执只覆盖实际返回的行。

来源刷新可以更新来源事实，但不能根据旧 marker、演示身份或对象是否来自人工而丢弃已保存科研对象。生产项目不依赖测试合成节点；需要演示拓扑的测试显式使用 [测试辅助](../../../tests/helpers/topology-fixture.ts)。

资产字节保存在应用资产根，数据库保存受控 storageKey 和元数据；API 返回领域身份与授权下载入口，不把磁盘路径当作通用读取权限。

## 生命周期与事务

SQLite 事务负责正式科研对象、状态与审计的协调；内存投影需要在失败时恢复，不能形成数据库失败而内存已提交的科研状态。事务辅助见 [sqlite-transaction.ts](../../../src/lib/sqlite-transaction.ts)。

会话历史使用 WAL 与 FULL synchronous。运行实例 maxSessions 不属于历史存储限制；有界 Trace 仅裁剪诊断事件，不裁剪回合正文和整个会话记录。保存失败必须可见和可重试。

科研资产、会话附件与 transfer 临时文件不是同一对象。候选绑定、正式绑定、草稿引用和历史引用决定保留；不能简单按文件年龄删除所有材料。

## 实验连续记录存储

[实验接收端](../modules/experiments-and-sources/README.md#持续接收) 的科研元数据、连续事件与查询数据分开。节点只表达科研归属；可选记录块的集合、手动 run 元数据与材料关联由共同研究表和版本保存，大量数组不写入 payload。每块独立，托管来源以项目为范围保存原始 run 和累计数据，记录块通过显式运行选择引用；累计数据不因多个块引用而复制。

[RecordIngestionService](../../../src/services/research/experiments/record-ingestion.ts) 使用同一项目 SQLite 中的事件 ledger、来源/运行目录、标量索引、水位、快照和附件清单。原始事件保留来源封装及事件类型，可按水位重放重建索引；静态导入在资产派生目录保存同一规范化事件索引，查询层合并静态事件与持续事件。SQLite FULL 事务把原始事件与索引一并提交后才确认，没有外部日志和数据库之间的确认窗口。持久和可查询水位分别返回，当前同事务推进而相等；重试同身份同内容幂等，同身份异内容回滚整批。

| 状态 | 权威范围 |
| --- | --- |
| 科研版本 | 块编辑、手动运行元数据和材料引用，沿用统一变更/候选/历史 |
| 数据水位 | 持久且可查询的连续观察；追加不触发节点修订 |
| 固定快照 | 查询水位、解释版本、节点/块/材料版本、运行选择、各来源水位及附件清单 |
| 附件齐全 | 独立于事件确认，不阻塞标量查询 |

点序号独立于 step，准确页走系列/序号索引；重复、回退、原始 dtype 与 restart 保留。数据库分桶采样保留边界/极值，不改变准确数据。快照的后续读取固定原目录，追加、改名或归档不会改写；删除节点后仍可按项目权限重读历史快照。

附件在资产根下的 record-blobs 中按实际接收范围（项目来源或已有块）及 SHA-256 管理；下载入口按块运行选择和快照水位解析实际范围，流式写临时文件、校验、sync、原子重命名后登记。原生日志按完整前缀分段归档，清单保留路径/代际/偏移；缺依赖和超额度明确记录。关闭项目先完成资源/解析释放再关闭数据库；应用 close 返回可等待的完成结果。

训练机的[持久队列](../../../scripts/runtime/topolumia_collector/spool.py) 使用独立 SQLite WAL/FULL。事件、必要文件和原生游标一起提交，ACK 后独立推进远端确认点；丢 ACK 重传相同身份。默认待发额度 128 MiB，附件 64 MiB，原件分段 4 MiB；背压暂停读取，停止保留队列。覆盖/截断建立新 generation，完整坏校验不跳过；无法恢复读取前已被外部删除的源文件。

备份同时覆盖应用 SQLite/WAL、资产与 record-blobs；未发送队列仍在训练机另行保留。凭据撤销和块归档不删除数据。旧节点级记录只做一次事务交接，原节点/块完整保留后进入单一新合同，不长期双写。

## 节点组归属

[节点组模块](../modules/node-groups/README.md) 的组对象由共同科研服务提交：ResearchRepository 管项目隔离的组及共同对象版本，NotebookStore 负责纪要和周期活动。组正式关系使用共同 edges，组不保存第二份可写边界边。

共同内容块使用类型化 owner 绑定 node/group，资产、候选、读取回执和历史按相同身份解析。统一事务提交组、成员、层级、块、关系、投影和历程；组删除不级联删除成员或真实文件。数据库、旧真实记录和资产不能在切换实现时自动清空，替换合同不等于授权重置数据。

## 检查与已知边界

- 研究一致性：[object-consistency.test.ts](../../../tests/research/object-consistency.test.ts)。
- 历史保留：[history-store.test.ts](../../../tests/agents/sessions/history-store.test.ts)。
- 恢复与保存：[reliability.test.ts](../../../tests/agents/sessions/reliability.test.ts)。
- 文件细节：[内容块生命周期](../modules/content-blocks/file-lifecycle.md)、[会话媒体](../modules/agent-workbench/sessions-and-media.md)。

这里描述当前存储机制，不承诺任意多进程共享同一应用数据目录。备份须覆盖数据库和文件，并正确处理 WAL，见 [运行维护](../../playbooks/operations.md)。

## 项目工作目录

项目 SQLite 的位置记录是项目主工作目录的权威，含本机/SSH/默认工作区选择及独立修订，已有未关联记录保持可读。创建项目、位置和创建者成员身份在同一事务保存；目录验证在提交前完成，不写入所选已有目录。项目 ID 自动生成，名称可以相同；默认位置预览使用与实际创建一致的 ID 和完整路径。

应用资产、配置和会话历史继续使用应用数据目录。关联本机目录只改变代码工作根，关联 SSH 目录不会将远端路径当成本机路径。更新使用观察修订；运行中拒绝切换，空闲时关闭原上下文并从同一项目数据重建。旧位置保存设置的目录修订与新位置不符时，运行环境选择和文件范围重新确定，科研内容与原件保留。机制见[环境模块](../modules/tools-and-environments/README.md#项目创建与工作目录)。
