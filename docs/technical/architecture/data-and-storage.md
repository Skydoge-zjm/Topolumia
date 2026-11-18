# 数据权威来源与存储

## 数据归属

| 数据 | 当前存储与责任 |
| --- | --- |
| 账号、登录、项目位置注册、成员与权限、协作审计 | 用户目录的 collaboration SQLite；[CollaborationStore](../../../src/services/platform/collaboration-store.ts) |
| 节点与组核心、块、对象/块版本、资产元数据、候选、读取回执、任务、拓扑投影与 MCP 调用审计 | 项目根/.topolumia/research.sqlite；[ProjectDataStore](../../../src/services/platform/project-data-store.ts) 和 [ResearchRepository](../../../src/services/research/objects/repository.ts) |
| 纪要、周期活动及其版本 | 项目科研库 research_documents / versions；[NotebookStore](../../../src/services/research/notebook-store.ts) |
| 科研历程 | 同一项目科研库；[ResearchHistoryStore](../../../src/services/research/history/history-store.ts) |
| Agent 会话 | .topolumia/agent-sessions/history.sqlite；[AgentHistoryStore](../../../src/services/agents/agent-history-store.ts) |
| 科研文件字节及派生预览 | .topolumia/research-assets；[资产服务](../../../src/services/research/assets/asset-service.ts) |
| 实验记录块、run 与材料对应 | 实验记录块的独立记录集合、块/集合版本和材料引用；连续事件、运行目录、索引、水位、快照与附件由记录接收表维护，静态导入的富事件索引与曲线索引均可从归档原件重建 |
| 会话图片与原生 imageView 快照 | history.sqlite 同级 attachments；[会话媒体](../../../src/services/agents/agent-attachment-service.ts) |
| 项目设置、原生 Agent 配置、Skill 快照与文件交接 | .topolumia/settings.json、agent-config、agent-skills、transfers；[项目装配](../../../src/application/project-runtime.ts) 决定路径 |

[app-paths.ts](../../../src/lib/app-paths.ts)在所有平台统一使用用户主目录下的 ~/.topolumia 保存账号、登录、全局配置和缓存，独立于源码和安装目录。全局配置为 ~/.topolumia/topolumia.config.json，账号库位于 data；默认科研工作区为 workspaces/<projectId>，每个工作区内部也有自己的 .topolumia。用户选择本机已有目录时，完整项目数据直接存入该目录/.topolumia。前后端共用全局配置解析，TOPOLUMIA_CONFIG 仅作为显式实例覆盖。

项目的 project.json 保存稳定 ID 和名称，research.sqlite 保存科研数据，其他相邻目录保存配置、会话和资产；项目数据不依赖原安装位置。移动或复制完整项目目录后，使用创建页的“本机已有目录”校验并打开已有项目，保留其身份和内容。账号权限与登录凭据由当前实例重新授予，不从项目副本导入。检测到损坏数据、异项目或两个已有副本时拒绝覆盖；已登记的数据目录消失时报告不可用，不重建空库。实现和回归见[项目目录](../../../src/services/platform/project-data-directory.ts)及[完整存储测试](../../../tests/platform/project-storage.test.ts)。

Python 记录读取器在所在主机使用同一根下 data/record-readers 保存私有凭据、依赖和队列；测试或受控部署可显式覆盖其数据位置。用户选择的现有本机或 SSH 科研目录保持原位置，应用默认工作区与其分别表达。


## 正式对象与投影

正式节点核心和内容块在研究对象表中；拓扑是逻辑关系与对象摘要的投影，不是第二份可独立修改的正文。变更提交通过同一服务协调对象、关系、投影和历史。

正式节点详情和概览按 owner 读取材料，关系与仅节点搜索读取对象元数据和拓扑，不加载无关正文。需要完整变更模拟的候选和写入仍使用完整快照。结构化读取被字符预算截断时标记 coverage 不完整，后续范围和读取回执只覆盖实际返回的行。

来源刷新可以更新来源事实，但不能根据旧 marker、演示身份或对象是否来自人工而丢弃已保存科研对象。生产项目不依赖测试合成节点；需要演示拓扑的测试显式使用 [测试辅助](../../../tests/helpers/topology-fixture.ts)。

资产字节保存在应用资产根，数据库保存受控 storageKey 和元数据；API 返回领域身份与授权下载入口，不把磁盘路径当作通用读取权限。

## 生命周期与事务

项目科研 SQLite 的同一事务负责正式对象、拓扑投影与科研历程；内存投影需要在失败时恢复，不能形成数据库失败而内存已提交的科研状态。账号库中的最近更新时间和状态版本仅用于项目列表缓存，不是科研权威。事务辅助见 [sqlite-transaction.ts](../../../src/lib/sqlite-transaction.ts)。

会话历史使用 WAL 与 FULL synchronous。运行实例 maxSessions 不属于历史存储限制；有界 Trace 仅裁剪诊断事件，不裁剪回合正文和整个会话记录。保存失败必须可见和可重试。

科研资产、会话附件与 transfer 临时文件不是同一对象。候选绑定、正式绑定、草稿引用和历史引用决定保留；不能简单按文件年龄删除所有材料。

项目删除以账号库 projects.status=deleted 为访问权威。先在项目库撤销采集授权，再通过账号库事务撤销成员、邀请、权限覆盖并记录审计；Agent 临时凭据同时清除，已有 SSE 连接收到访问撤销。删除期间阻止新运行时请求，运行中的 Agent、整理器、来源刷新、关键操作和 HTTP 请求阻止删除；空闲项目停用采集、关闭转发与运行时后从注册表释放。不可连接或尚未加载的主机读取器可能仍在原主机运行，返回停止结果，失效凭据禁止其继续提交。完整 .topolumia 和本机/SSH 工作目录均保留。默认项目的删除标记保留，启动时不构建其运行时；认证、列表和创建接口不依赖项目运行时。实现与回归见[删除测试](../../../tests/platform/project-deletion.test.ts)。

## 实验连续记录存储

[实验接收端](../modules/experiments-and-sources/README.md#持续接收) 的科研元数据、连续事件与查询数据分开。节点只表达科研归属；可选记录块的集合、手动 run 元数据与材料关联由共同研究表和版本保存，大量数组不写入 payload。每块独立，托管来源以项目为范围保存原始 run 和累计数据，记录块通过显式运行选择引用；累计数据不因多个块引用而复制。

[RecordIngestionService](../../../src/services/research/experiments/record-ingestion.ts) 使用同一项目 SQLite 中的事件 ledger、来源/运行目录、标量索引、水位、快照和附件清单。原始事件保留来源封装及事件类型，可按水位重放重建索引；静态导入在资产派生目录保存同一规范化事件索引，查询层合并静态事件与持续事件。SQLite FULL 事务把原始事件与索引一并提交后才确认，没有外部日志和数据库之间的确认窗口。持久和可查询水位分别返回，当前同事务推进而相等；重试同身份同内容幂等，同身份异内容回滚整批。

| 状态 | 权威范围 |
| --- | --- |
| 科研版本 | 块编辑、手动运行元数据和材料引用，沿用统一变更/候选/历史 |
| 数据水位 | 持久且可查询的连续观察；追加不触发节点修订 |
| 固定快照 | 查询水位、解释版本、节点/块/材料版本、运行选择、各来源水位及附件清单 |
| 附件齐全 | 独立于事件确认，不阻塞标量查询 |

MLflow 读取导入复用相同项目来源、事件 ledger 和查询索引：完整读取所选运行的全部分页后，在同一 SQLite 事务中写入，失败不发布部分选择。来源身份由服务、实验、运行和原始内容摘要决定；重复内容幂等，上游变化生成新的不可变来源版本，已绑定块和快照保留原版本。服务离线后依然从本机持久记录查询，不维护另一套快照或内存指标权威。

点序号独立于 step，准确页走系列/序号索引；重复、回退、原始 dtype 与 restart 保留。数据库分桶采样保留边界/极值，不改变准确数据。快照的后续读取固定原目录，追加、改名或归档不会改写；删除节点后仍可按项目权限重读历史快照。

附件在资产根下的 record-blobs 中按实际接收范围（项目来源或已有块）及 SHA-256 管理；下载入口按块运行选择和快照水位解析实际范围，流式写临时文件、校验、sync、原子重命名后登记。原生日志按完整前缀分段归档，清单保留路径/代际/偏移；缺依赖和超额度明确记录。关闭项目先完成资源/解析释放再关闭数据库；应用 close 返回可等待的完成结果。

训练机的[持久队列](../../../scripts/runtime/topolumia_collector/spool.py) 使用独立 SQLite WAL/FULL。事件、必要文件和原生游标一起提交，ACK 后独立推进远端确认点；丢 ACK 重传相同身份。默认待发额度 128 MiB，附件 64 MiB，原件分段 4 MiB；背压暂停读取，停止保留队列。覆盖/截断建立新 generation，完整坏校验不跳过；无法恢复读取前已被外部删除的源文件。

备份覆盖完整项目 .topolumia，包含科研 SQLite/WAL、会话库、资产与 record-blobs；未发送队列仍在训练机另行保留。凭据撤销和块归档不删除数据。初始化复制既有应用数据时先完整复制和校验，再发布项目目录，保留原件；之后只有项目库参与科研读写，不维持双写。

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

账号库的位置注册记录本机/SSH/默认工作区选择及独立修订，项目 manifest 决定数据身份。目录浏览与校验只读；实际创建才写入 .topolumia，原代码和研究文件保持原样。新项目自动生成 ID；已有 manifest 的目录使用原 ID 和名称，不覆盖原配置或内容。账号库的项目注册、位置和创建者成员身份在同一事务保存。

更换本机工作目录使用观察修订并检查运行状态，先暂停后台协调、关闭运行时和数据库，再复制完整 .topolumia、校验并切换位置，原位置保留副本；目标已有另一份数据时不覆盖。项目整体移走后可从新位置重新关联，旧目录不会被自动重建。SSH 项目在独立本机项目根保存同样的 .topolumia，远端目录是代码和训练位置，不通过 SFTP 直接访问 SQLite。目录修订变化时重新确认 Python 选择与文件范围，科研内容和会话保留。机制见[环境模块](../modules/tools-and-environments/README.md#项目创建与工作目录)。
