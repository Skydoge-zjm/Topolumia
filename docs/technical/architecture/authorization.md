# 权限边界

业务依据：[科研变更](../../product/business/research-changes.md)、[Agent 协作](../../product/business/agent-collaboration.md)。权限由服务端当前身份决定，UI 禁用和 MCP 工具目录过滤是辅助体验。

## 入口与领域动作

[HTTP authorization](../../../src/http/authorization.ts) 解析用户、项目和会话，检查访问边界；[CollaborationStore](../../../src/services/platform/collaboration-store.ts) 管成员、角色、覆盖权限和凭据。领域服务对具体动作再次校验，不能因为路由允许访问项目就默认可以提交所有变化。

MCP 的访问控制、每次调用授权与审计，不能代替 HTTP 和领域服务检查。即使绕过 MCP 直接调用 CLI/HTTP，也必须获得相同结果。

## 科研审批

[reviewPermission](../../../src/domain/research/review-policy.ts) 统一决定 accept 需要 research.applyChange，reject/defer 需要 research.review。涉及删除的接受还需撤销/替代权限。Agent 凭据不得自行审批。

候选读取范围、读取回执、正式对象版本、资产归属在执行时校验。幂等性防止重复提交，不能用来跳过授权。

节点组的 [领域权限](../modules/node-groups/interfaces-and-changes.md#授权历程与刷新) 复用科研权限：查看、直接修改、候选提出与审批分别授权；删除组及接受含删除组候选还需 research.withdrawOrSupersede。类型化 node/group 引用、成员与父组均校验当前项目，Agent 不能借人工组接口绕过审批。

## 原生执行审批

[approval-policy.ts](../../../src/services/agents/approval-policy.ts) 重新判断风险，不信任客户端或原生事件自报级别。

只有路径明确、解析现有祖先真实路径后仍在项目内的单次文件变更属于普通审批。相对路径依据请求 cwd；符号链接越界仍按项目外处理。

命令、网络、权限扩展、未知请求、外部路径，以及会话级或持久授权，需要 agent.approveHighRiskTool。持久拒绝也会修改策略，因此同样受限；普通拒绝和停止仍可用。

网关在调用 driver 前检查当前权限；前端复用 [共享选项策略](../../../src/domain/agents/agent-approval.ts)，显示禁用原因，不能仅依赖创建会话时的旧权限。

## 持续连接

### 实验采集授权

采集授权限定项目来源及授予用户，来源保存主机与目录；授权由“工具与环境”的托管部署创建和维护，读取器使用私有凭据文件。部署、目录配置和进程操作要求 project.manageSettings，项目记录读取要求 research.view；科研归属修改要求 research.applyChange。接收请求逐次检查授予者当前权限，附件落盘前再次检查；凭据仅可向指定来源提交事件和附件，不拥有节点、关系、审批或运行归属修改能力。

项目来源先保存新 run，再由人工明确选择到实验记录块；Agent 归组沿用候选审批。明确的专属目录规则只追加匹配的来源事实，不能改写人工元数据。块查询、事件文本、附件与快照按所选 run 及来源水位校验，不能利用同项目凭据越过块选择范围。

暂停或撤销采集不删除已接收记录及队列，归档块不撤销其他块引用的来源。查询继续检查当前项目权限。采集凭据不复用浏览器 cookie、Agent 凭据或第三方 Key，不进入常规 Agent 上下文、API 状态或部署日志。

平台在授权临近到期时续期，暂停拒绝后续接收，恢复保持来源身份。旧块已有的累计记录和固定快照仍按原范围读取，不复制到项目来源；普通用户入口统一使用项目来源。
